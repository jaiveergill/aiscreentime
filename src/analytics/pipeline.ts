import type {
  EventPayload,
  NormalizedEvent,
  TaskCategory,
  TaskEstimate,
  TaskRecord,
  TaskStatus,
} from '../core/types.ts';
import { dayKey, hashId, uniq } from '../core/util.ts';
import { log } from '../core/log.ts';
import type { Db } from '../store/db.ts';
import type { Settings } from '../core/config.ts';
import {
  extractEvidence,
  reconstructTasks,
  segmentPaths,
  segmentTitle,
  type TaskSegment,
} from '../tasks/reconstruct.ts';
import { assessRelevance, researchDepthMultiplier } from '../tasks/relevance.ts';
import { readTaskAdjustment } from '../semantic/pass.ts';
import { categorize } from '../tasks/categorize.ts';
import { verifyOutcome, type VerificationResult } from '../verify/outcome.ts';
import { estimateTask, type SemanticAdjustment } from '../estimate/model.ts';
import { BENCHMARK_VERSION } from '../estimate/priors.ts';
import { calibrationFor } from '../calibration/model.ts';
import { commitsInRange, isGitRepo, type GitCommit } from '../git/git.ts';
import { estimateRepoSize } from '../repo/resolve.ts';
import { isInfraPath, isMigrationPath, languageOf } from '../normalize/paths.ts';
import {
  computeAgentIntervals,
  computeSteering,
  steeringWithin,
  STEERING_BALANCED,
} from '../steering/model.ts';

export interface ComputeOptions {
  readonly settings: Settings;
  readonly from?: number;
  readonly to?: number;
  readonly semanticProvider?: (
    segments: readonly SemanticRequest[],
  ) => Promise<Map<string, SemanticAdjustment>>;
  readonly signal?: AbortSignal;
}

export interface SemanticRequest {
  readonly taskId: string;
  readonly title: string;
  readonly category: TaskCategory;
  readonly redactedSummary: string;
}

export interface ComputeResult {
  readonly tasksBuilt: number;
  readonly estimatesWritten: number;
  readonly daysTouched: string[];
  readonly durationMs: number;
  /** Segments rejected by the engineering-relevance gate. */
  readonly nonEngineeringRejected: number;
}

interface RepoInfo {
  readonly repoId: string;
  readonly root: string;
  readonly isGit: boolean;
  readonly fileCount: number;
  readonly commits: GitCommit[];
}

/**
 * The derivation pipeline.
 *
 * Reads normalized events, reconstructs tasks, verifies outcomes, estimates
 * counterfactual time, and writes the derived tables. Everything it produces is
 * regenerable from `events` plus user overrides, so it is safe to re-run at any
 * time — and it must be re-run after any settings change that affects scope.
 */
export function computeDerived(db: Db, opts: ComputeOptions): ComputeResult {
  const t0 = Date.now();
  const from = opts.from ?? 0;
  const to = opts.to ?? Date.now();
  const tz = opts.settings.timezone || undefined;

  const events = loadEvents(db, from, to, opts.settings);
  if (events.length === 0) {
    // Still clear the window. A scope change that removes every event must not
    // leave stale tasks and metrics behind — otherwise excluding your only
    // repository would appear to do nothing.
    const cleared = clearWindow(db, from, to);
    return {
      tasksBuilt: 0,
      estimatesWritten: 0,
      daysTouched: cleared,
      durationMs: Date.now() - t0,
      nonEngineeringRejected: 0,
    };
  }

  const segments = reconstructTasks(events);
  log.info('reconstructed segments', { count: segments.length, events: events.length });

  // Steering and agent runtime are computed once over the whole window, then
  // clipped per task. Computing them per task would double-count overlaps.
  const steering = computeSteering(events, STEERING_BALANCED);
  const agentIntervals = computeAgentIntervals(events);
  const agentBySession = new Map<string, [number, number][]>();
  for (const iv of agentIntervals) {
    const arr = agentBySession.get(iv.sessionId);
    if (arr) arr.push([iv.start, iv.end]);
    else agentBySession.set(iv.sessionId, [[iv.start, iv.end]]);
  }

  const repoCache = new Map<string, RepoInfo>();
  const overrides = loadOverrides(db);
  const daysTouched = new Set<string>();
  let estimatesWritten = 0;

  const insertTask = db.handle.prepare(`
    INSERT INTO tasks (task_id, title, intent, category, category_source, status, status_source,
                       repo_id, started_at, ended_at, day_key, session_ids, providers, evidence,
                       wall_clock_ms, agent_active_ms, steering_ms, excluded, user_edited,
                       merged_from, related_task_ids)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(task_id) DO UPDATE SET
      title=excluded.title, intent=excluded.intent, category=excluded.category,
      category_source=excluded.category_source, status=excluded.status,
      status_source=excluded.status_source, repo_id=excluded.repo_id,
      started_at=excluded.started_at, ended_at=excluded.ended_at, day_key=excluded.day_key,
      session_ids=excluded.session_ids, providers=excluded.providers, evidence=excluded.evidence,
      wall_clock_ms=excluded.wall_clock_ms, agent_active_ms=excluded.agent_active_ms,
      steering_ms=excluded.steering_ms, excluded=excluded.excluded, user_edited=excluded.user_edited
  `);
  const insertTaskEvent = db.handle.prepare(
    'INSERT OR IGNORE INTO task_events (task_id, event_id) VALUES (?,?)',
  );
  const insertEstimate = db.handle.prepare(`
    INSERT INTO estimates (task_id, benchmark_version, payload, computed_at)
    VALUES (?,?,?,?)
    ON CONFLICT(task_id, benchmark_version) DO UPDATE SET
      payload=excluded.payload, computed_at=excluded.computed_at
  `);

  const built: { record: TaskRecord; verification: VerificationResult }[] = [];
  let rejected = 0;
  const rejectedByReason = new Map<string, number>();

  db.transaction(() => {
    for (const d of clearWindow(db, from, to)) daysTouched.add(d);

    for (const seg of segments) {
      if (opts.signal?.aborted) break;
      const taskId = hashId('task', seg.sessionIds.join(','), seg.startedAt, seg.paths.size);
      const repo = seg.repoId
        ? getRepoInfo(db, repoCache, seg.repoId, seg.startedAt, seg.endedAt)
        : undefined;

      // Gate: only software-engineering work becomes a task. Assistant use that
      // is not engineering has no counterfactual engineering time and must not
      // reach the headline.
      const relevance = assessRelevance(seg, repo?.isGit ?? false);
      if (relevance.verdict === 'non-engineering') {
        rejected++;
        rejectedByReason.set(
          relevance.score.toString(),
          (rejectedByReason.get(relevance.score.toString()) ?? 0) + 1,
        );
        continue;
      }

      const paths = segmentPaths(seg);
      const evidence = extractEvidence(seg, repo?.root);

      const verification = verifyOutcome({
        events: seg.events,
        evidence,
        paths,
        ...(repo ? { repoRoot: repo.root, commits: repo.commits } : {}),
        repoIsGit: repo?.isGit ?? false,
        taskStart: seg.startedAt,
        taskEnd: seg.endedAt,
      });

      const commitsTouching = countCommitsTouching(repo, paths, seg.startedAt);
      const evidenceWithGit = {
        ...evidence,
        commits: commitsTouching.commits,
        revertedCommits: commitsTouching.reverts,
        filesStillPresent: verification.filesStillPresent,
        filesMissing: verification.filesMissing,
      };

      const brownfieldRatio =
        evidence.filesChanged === 0 ? 0 : 1 - evidence.filesAdded / evidence.filesChanged;
      const cat = categorize({
        text: seg.instructionText,
        evidence: evidenceWithGit,
        paths,
        brownfieldRatio,
        repoIsMature: (repo?.fileCount ?? 0) > 150,
      });

      const override = overrides.get(taskId);
      const category = (override?.category as TaskCategory | undefined) ?? cat.category;
      const status = (override?.status as TaskStatus | undefined) ?? verification.status;
      const excluded =
        override?.excluded === 1 || opts.settings.excludedCategories.includes(category);

      const steeringMs = steeringWithin(steering, seg.startedAt, seg.endedAt);
      const agentActiveMs = agentMsForSegment(agentBySession, seg);

      const record: TaskRecord = {
        taskId,
        title: override?.title ?? segmentTitle(seg),
        intent: seg.instructionText.slice(0, 500),
        category,
        categorySource: override?.category ? 'user-corrected' : 'inferred',
        status,
        statusSource: override?.status ? 'user-corrected' : 'inferred',
        ...(seg.repoId ? { repoId: seg.repoId } : {}),
        startedAt: seg.startedAt,
        endedAt: seg.endedAt,
        sessionIds: seg.sessionIds,
        providers: seg.providers,
        evidence: evidenceWithGit,
        wallClockMs: seg.endedAt - seg.startedAt,
        agentActiveMs,
        steeringMs,
        excluded,
        userEdited: override !== undefined,
        dayKey: dayKey(seg.startedAt, tz),
      };

      insertTask.run(
        record.taskId,
        record.title,
        record.intent,
        record.category,
        record.categorySource,
        record.status,
        record.statusSource,
        record.repoId ?? null,
        record.startedAt,
        record.endedAt,
        record.dayKey,
        JSON.stringify(record.sessionIds),
        JSON.stringify(record.providers),
        JSON.stringify(record.evidence),
        record.wallClockMs,
        record.agentActiveMs,
        record.steeringMs,
        record.excluded ? 1 : 0,
        record.userEdited ? 1 : 0,
        JSON.stringify(seg.groupingReasons),
        null,
      );
      for (const e of seg.events) insertTaskEvent.run(taskId, e.id);
      daysTouched.add(record.dayKey);

      const langs = uniq(paths.map(languageOf)).length;
      const calibration = calibrationFor(db, category);
      const depth = researchDepthMultiplier(seg.events);
      // Applied only if a prior semantic pass produced one. Never blocks.
      const semantic = opts.settings.semanticEnabled ? readTaskAdjustment(db, taskId) : undefined;

      const estimate = estimateTask({
        taskId,
        category,
        categoryConfidence: override?.category ? 1 : cat.confidence,
        evidence: evidenceWithGit,
        verification: { ...verification, status },
        researchDepth: depth,
        ...(semantic ? { semantic } : {}),
        ...(repo?.fileCount ? { repoFileCount: repo.fileCount } : {}),
        repoIsGit: repo?.isGit ?? false,
        languageCount: Math.max(1, langs),
        touchesMigration: paths.some(isMigrationPath),
        touchesInfra: paths.some(isInfraPath),
        ...(calibration ? { calibration } : {}),
        ...(override?.hours !== undefined && override.hours !== null
          ? { userOverrideHours: override.hours }
          : {}),
      });
      insertEstimate.run(taskId, BENCHMARK_VERSION, JSON.stringify(estimate), Date.now());
      estimatesWritten++;

      built.push({ record, verification });
    }
  });

  db.setConfig('lastComputeStats', {
    at: Date.now(),
    tasksBuilt: built.length,
    nonEngineeringRejected: rejected,
    rejectedScoreHistogram: Object.fromEntries(rejectedByReason),
  });

  return {
    tasksBuilt: built.length,
    estimatesWritten,
    daysTouched: [...daysTouched].sort(),
    durationMs: Date.now() - t0,
    nonEngineeringRejected: rejected,
  };
}

/**
 * Drop every derived row in a time window and return the day keys affected, so
 * their metrics can be recomputed (or zeroed) by the caller.
 */
function clearWindow(db: Db, from: number, to: number): string[] {
  const days = (
    db.handle
      .prepare('SELECT DISTINCT day_key FROM tasks WHERE started_at BETWEEN ? AND ?')
      .all(from, to) as { day_key: string }[]
  ).map((r) => r.day_key);
  db.handle
    .prepare(
      'DELETE FROM task_events WHERE task_id IN (SELECT task_id FROM tasks WHERE started_at BETWEEN ? AND ?)',
    )
    .run(from, to);
  db.handle
    .prepare(
      'DELETE FROM estimates WHERE task_id IN (SELECT task_id FROM tasks WHERE started_at BETWEEN ? AND ?)',
    )
    .run(from, to);
  db.handle.prepare('DELETE FROM tasks WHERE started_at BETWEEN ? AND ?').run(from, to);
  for (const d of days) {
    db.handle.prepare('DELETE FROM day_metrics WHERE day_key = ?').run(d);
  }
  return days;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export function loadEvents(
  db: Db,
  from: number,
  to: number,
  settings: Settings,
): NormalizedEvent[] {
  const rows = db.handle
    .prepare(
      `SELECT e.* FROM events e
       WHERE e.ts BETWEEN ? AND ? AND e.is_replay = 0
       ORDER BY e.ts ASC`,
    )
    .all(from, to) as Record<string, unknown>[];

  const excludedSessions = new Set(settings.excludedSessions);
  const excludedRepoIds = new Set(
    (
      db.handle.prepare('SELECT repo_id, root FROM repos').all() as {
        repo_id: string;
        root: string;
      }[]
    )
      .filter((r) => settings.excludedRepos.includes(r.root))
      .map((r) => r.repo_id),
  );

  const out: NormalizedEvent[] = [];
  for (const r of rows) {
    const sessionId = String(r['session_id']);
    if (excludedSessions.has(sessionId)) continue;
    const repoId = r['repo_id'] === null ? undefined : String(r['repo_id']);
    if (repoId && excludedRepoIds.has(repoId)) continue;
    let payload: EventPayload;
    try {
      payload = JSON.parse(String(r['payload'])) as EventPayload;
    } catch {
      payload = {};
    }
    out.push({
      id: String(r['id']),
      sessionId,
      provider: String(r['provider']),
      kind: String(r['kind']) as NormalizedEvent['kind'],
      ts: Number(r['ts']),
      ...(r['ts_raw'] ? { tsRaw: String(r['ts_raw']) } : {}),
      ...(r['cwd'] ? { cwd: String(r['cwd']) } : {}),
      ...(repoId ? { repoId } : {}),
      ...(r['turn_id'] ? { turnId: String(r['turn_id']) } : {}),
      isSubagent: Number(r['is_subagent']) === 1,
      isReplay: Number(r['is_replay']) === 1,
      payload,
      provenance: {
        provider: String(r['provider']),
        sourceFile: String(r['src_file']),
        lineIndex: Number(r['src_line']),
        byteOffset: Number(r['src_byte']),
        parser: String(r['parser']),
        ...(r['provider_version'] ? { providerVersion: String(r['provider_version']) } : {}),
      },
    });
  }
  return out;
}

interface OverrideRow {
  title?: string;
  category?: string;
  status?: string;
  excluded?: number;
  hours?: number;
}

function loadOverrides(db: Db): Map<string, OverrideRow> {
  const rows = db.handle.prepare('SELECT * FROM task_overrides').all() as Record<string, unknown>[];
  const m = new Map<string, OverrideRow>();
  for (const r of rows) {
    m.set(String(r['task_id']), {
      ...(r['title'] ? { title: String(r['title']) } : {}),
      ...(r['category'] ? { category: String(r['category']) } : {}),
      ...(r['status'] ? { status: String(r['status']) } : {}),
      ...(r['excluded'] !== null && r['excluded'] !== undefined
        ? { excluded: Number(r['excluded']) }
        : {}),
      ...(r['hours'] !== null && r['hours'] !== undefined ? { hours: Number(r['hours']) } : {}),
    });
  }
  return m;
}

function getRepoInfo(
  db: Db,
  cache: Map<string, RepoInfo>,
  repoId: string,
  from: number,
  to: number,
): RepoInfo | undefined {
  const hit = cache.get(repoId);
  if (hit) return hit;
  const row = db.handle.prepare('SELECT * FROM repos WHERE repo_id = ?').get(repoId) as
    Record<string, unknown> | undefined;
  if (!row) return undefined;
  const root = String(row['root']);
  const isGit = Number(row['is_git']) === 1 && isGitRepo(root);
  let fileCount = row['file_count'] === null ? 0 : Number(row['file_count']);
  if (!fileCount) {
    fileCount = estimateRepoSize(root);
    db.handle.prepare('UPDATE repos SET file_count = ? WHERE repo_id = ?').run(fileCount, repoId);
  }
  // Look a day past the task window so post-session commits are visible.
  const commits = isGit ? commitsInRange(root, from - 3600_000, to + 24 * 3600_000) : [];
  const info: RepoInfo = { repoId, root, isGit, fileCount, commits };
  cache.set(repoId, info);
  return info;
}

function countCommitsTouching(
  repo: RepoInfo | undefined,
  paths: readonly string[],
  since: number,
): { commits: number; reverts: number } {
  if (!repo || paths.length === 0) return { commits: 0, reverts: 0 };
  const rel = new Set(
    paths.map((p) => (p.startsWith(repo.root) ? p.slice(repo.root.length + 1) : p)),
  );
  let commits = 0;
  let reverts = 0;
  for (const c of repo.commits) {
    if (c.ts < since - 5 * 60_000) continue;
    if (!c.paths.some((p) => rel.has(p))) continue;
    if (c.isRevert) reverts++;
    else commits++;
  }
  return { commits, reverts };
}

function agentMsForSegment(bySession: Map<string, [number, number][]>, seg: TaskSegment): number {
  let total = 0;
  for (const sid of seg.sessionIds) {
    for (const [s, e] of bySession.get(sid) ?? []) {
      const a = Math.max(s, seg.startedAt);
      const b = Math.min(e, seg.endedAt);
      if (b > a) total += b - a;
    }
  }
  return total;
}

export type { TaskEstimate };
