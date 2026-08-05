import fs from 'node:fs';
import path from 'node:path';

import type { TaskCategory, TaskStatus } from '../core/types.ts';
import { HOUR, dayKey, endOfDay, startOfDay } from '../core/util.ts';
import { log } from '../core/log.ts';
import { Db } from '../store/db.ts';
import { loadSettings, saveSettings, type Settings } from '../core/config.ts';
import { ClaudeCodeCollector } from '../collectors/claude/index.ts';
import { CodexCollector } from '../collectors/codex/index.ts';
import type { Collector } from '../collectors/types.ts';
import { ingest, type IngestProgress } from '../ingest/engine.ts';
import { computeDerived, loadEvents } from '../analytics/pipeline.ts';
import {
  activeDays,
  computeDayMetrics,
  emptyDayMetrics,
  loadDayMetrics,
  loadEstimates,
  loadTask,
  loadTasksForDay,
  trend,
} from '../analytics/metrics.ts';
import {
  computeAgentIntervals,
  computeConcurrency,
  computeSteering,
  STEERING_BALANCED,
} from '../steering/model.ts';
import { CATEGORY_LABELS } from '../tasks/categorize.ts';
import { PRIOR_SOURCES, CATEGORY_PRIORS, BENCHMARK_VERSION } from '../estimate/priors.ts';
import { calibrationSummary, listCalibrations, recordCalibration } from '../calibration/model.ts';
import {
  aliasProjects,
  describeExposure,
  renderCard,
  type CardOptions,
  type CardVariant,
} from '../share/card.ts';
import { listExternalRequests } from '../semantic/provider.ts';
import { runSemanticPass } from '../semantic/pass.ts';
import { clearRepoCache } from '../repo/resolve.ts';
import { redactPath } from '../privacy/redact.ts';

export interface ApiContext {
  readonly db: Db;
  readonly collectors: readonly Collector[];
  /** Live ingestion state, surfaced to the UI without polling the filesystem. */
  state: {
    ingesting: boolean;
    progress?: IngestProgress;
    lastIngest?: { at: number; events: number; files: number; durationMs: number };
    lastCompute?: { at: number; tasks: number; rejected: number; durationMs: number };
    abort?: AbortController;
  };
}

export function createContext(dbDir?: string): ApiContext {
  const db = new Db(dbDir ? { dir: dbDir } : {});
  const ctx: ApiContext = {
    db,
    collectors: [new ClaudeCodeCollector(), new CodexCollector()],
    state: { ingesting: false },
  };
  rebuildIfStale(ctx);
  return ctx;
}

/**
 * Recompute when the derived tables cannot answer for the tasks already stored
 * — a migration that dropped them, or a benchmark version bump. Without this a
 * day would render as zeros until the next scan happened to find new events,
 * which reads as data loss.
 */
function rebuildIfStale(ctx: ApiContext): void {
  const tasks = (ctx.db.handle.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }).n;
  if (tasks === 0) return;
  const estimates = (
    ctx.db.handle
      .prepare('SELECT COUNT(*) n FROM estimates WHERE benchmark_version = ?')
      .get(BENCHMARK_VERSION) as { n: number }
  ).n;
  if (estimates > 0) return;
  log.info('derived data is stale; rebuilding', { tasks });
  const settings = loadSettings(ctx.db);
  const res = computeDerived(ctx.db, { settings, from: 0 });
  for (const d of res.daysTouched) computeDayMetrics(ctx.db, d, settings);
}

export interface ApiResponse {
  status: number;
  body: unknown;
  contentType?: string;
  raw?: string | Buffer;
}

const json = (body: unknown, status = 200): ApiResponse => ({ status, body });
const fail = (message: string, status = 400): ApiResponse => ({ status, body: { error: message } });

/**
 * The whole API surface.
 *
 * Routing is a plain switch: there are fewer than thirty endpoints, and a
 * framework would add dependencies and indirection for no benefit in a
 * single-user local application.
 */
export async function handleApi(
  ctx: ApiContext,
  method: string,
  url: URL,
  body: unknown,
): Promise<ApiResponse> {
  const p = url.pathname;
  const settings = loadSettings(ctx.db);

  // ---- status & onboarding ---------------------------------------------
  if (p === '/api/status' && method === 'GET') {
    const detections = await Promise.all(ctx.collectors.map((c) => c.detect()));
    const sources = ctx.db.handle
      .prepare(
        'SELECT provider, COUNT(*) n, SUM(events_ingested) ev, MAX(last_ingested) last FROM sources GROUP BY provider',
      )
      .all() as { provider: string; n: number; ev: number; last: number }[];
    const eventCount = (
      ctx.db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }
    ).n;
    const taskCount = (ctx.db.handle.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number })
      .n;
    return json({
      onboarded: settings.onboarded,
      settings,
      detections,
      sources,
      eventCount,
      taskCount,
      days: activeDays(ctx.db, 120),
      today: dayKey(Date.now(), settings.timezone || undefined),
      benchmarkVersion: BENCHMARK_VERSION,
      ingesting: ctx.state.ingesting,
      progress: ctx.state.progress ?? null,
      lastIngest: ctx.state.lastIngest ?? null,
      lastCompute: ctx.state.lastCompute ?? null,
      dbPath: ctx.db.file,
      dbBytes: ctx.db.sizeBytes(),
    });
  }

  if (p === '/api/ingest' && method === 'POST') {
    if (ctx.state.ingesting) return fail('Ingestion already running.', 409);
    if (settings.paused) return fail('Collection is paused. Resume it in Privacy settings.', 409);
    const b = (body ?? {}) as { historyDays?: number; recompute?: boolean };
    const s: Settings =
      b.historyDays !== undefined ? { ...settings, historyDays: b.historyDays } : settings;
    await runIngest(ctx, s, b.recompute !== false);
    return json({ ok: true, lastIngest: ctx.state.lastIngest, lastCompute: ctx.state.lastCompute });
  }

  // ---- day view ----------------------------------------------------------
  if (p.startsWith('/api/day/') && method === 'GET') {
    const day = p.slice('/api/day/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail('Invalid day.');
    const metrics = loadDayMetrics(ctx.db, day) ?? computeDayMetrics(ctx.db, day, settings);
    const tasks = loadTasksForDay(ctx.db, day);
    const estimates = loadEstimates(
      ctx.db,
      tasks.map((t) => t.taskId),
    );
    const repos = repoNameMap(ctx.db);
    return json({
      day,
      metrics,
      repos,
      tasks: tasks.map((t) => ({
        ...t,
        estimate: estimates.get(t.taskId) ?? null,
        repoName: t.repoId ? (repos[t.repoId] ?? null) : null,
        categoryLabel: CATEGORY_LABELS[t.category],
      })),
    });
  }

  if (p.startsWith('/api/timeline/') && method === 'GET') {
    const day = p.slice('/api/timeline/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail('Invalid day.');
    const from = startOfDay(day);
    const to = endOfDay(day);
    const events = loadEvents(ctx.db, from, to, settings);
    const steer = computeSteering(events, STEERING_BALANCED);
    // Clip to the requested day. A measured turn duration can legitimately
    // start before midnight, and letting it widen the axis squashes the whole
    // day into a sliver.
    const clip = (a: number, b: number): [number, number] | null => {
      const lo = Math.max(a, from);
      const hi = Math.min(b, to);
      return hi > lo ? [lo, hi] : null;
    };
    const agents = computeAgentIntervals(events)
      .map((iv) => {
        const c = clip(iv.start, iv.end);
        return c ? { ...iv, start: c[0], end: c[1] } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    const steeringClipped = steer.intervals
      .map(([a, b]) => clip(a, b))
      .filter((x): x is [number, number] => x !== null);
    const conc = computeConcurrency(agents);
    const tasks = loadTasksForDay(ctx.db, day).filter((t) => !t.excluded);
    const taskEventIds = new Map<string, string[]>();
    for (const t of tasks) {
      const rows = ctx.db.handle
        .prepare('SELECT event_id FROM task_events WHERE task_id = ?')
        .all(t.taskId) as { event_id: string }[];
      taskEventIds.set(
        t.taskId,
        rows.map((r) => r.event_id),
      );
    }
    const eventById = new Map(events.map((e) => [e.id, e]));
    const markers = tasks.flatMap((t) =>
      (taskEventIds.get(t.taskId) ?? [])
        .map((id) => eventById.get(id))
        .filter(
          (e): e is NonNullable<typeof e> =>
            e !== undefined &&
            [
              'test.run',
              'build.run',
              'user.interrupt',
              'error.encountered',
              'git.commit',
              'subagent.spawned',
            ].includes(e.kind),
        )
        .map((e) => ({
          taskId: t.taskId,
          ts: e.ts,
          kind: e.kind,
          outcome: e.payload.outcome ?? null,
        })),
    );
    return json({
      day,
      from,
      to,
      steering: steeringClipped,
      agents: agents.map((a) => ({
        sessionId: a.sessionId,
        start: a.start,
        end: a.end,
        measured: a.measured,
      })),
      concurrency: conc.samples,
      peak: conc.peak,
      markers,
      tasks: tasks.map((t) => ({
        taskId: t.taskId,
        title: t.title,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
        status: t.status,
        category: t.category,
        repoId: t.repoId ?? null,
        sessionIds: t.sessionIds,
        providers: t.providers,
      })),
    });
  }

  if (p === '/api/trend' && method === 'GET') {
    const days = Number(url.searchParams.get('days') ?? 14);
    return json({ trend: trend(ctx.db, Math.min(120, Math.max(2, days)), settings) });
  }

  // ---- task detail -------------------------------------------------------
  if (p.startsWith('/api/task/') && method === 'GET') {
    const taskId = p.slice('/api/task/'.length);
    const task = loadTask(ctx.db, taskId);
    if (!task) return fail('Task not found.', 404);
    const estimate = loadEstimates(ctx.db, [taskId]).get(taskId) ?? null;
    const eventRows = ctx.db.handle
      .prepare(
        `SELECT e.* FROM events e JOIN task_events te ON te.event_id = e.id
         WHERE te.task_id = ? ORDER BY e.ts ASC LIMIT 4000`,
      )
      .all(taskId) as Record<string, unknown>[];
    const events = eventRows.map((r) => ({
      id: String(r['id']),
      kind: String(r['kind']),
      ts: Number(r['ts']),
      provider: String(r['provider']),
      sessionId: String(r['session_id']),
      payload: safeParse(r['payload']),
      source: {
        file: redactPath(String(r['src_file']), 4),
        line: Number(r['src_line']),
        byte: Number(r['src_byte']),
        parser: String(r['parser']),
        providerVersion: r['provider_version'] ? String(r['provider_version']) : null,
      },
    }));
    const sessions = ctx.db.handle
      .prepare(
        `SELECT * FROM sessions WHERE session_id IN (${task.sessionIds.map(() => '?').join(',') || "''"})`,
      )
      .all(...task.sessionIds) as Record<string, unknown>[];
    const repos = repoNameMap(ctx.db);
    const groupingRow = ctx.db.handle
      .prepare('SELECT merged_from FROM tasks WHERE task_id = ?')
      .get(taskId) as { merged_from: string } | undefined;
    return json({
      task: {
        ...task,
        categoryLabel: CATEGORY_LABELS[task.category],
        repoName: task.repoId ? repos[task.repoId] : null,
      },
      estimate,
      events,
      sessions: sessions.map((s) => ({
        sessionId: String(s['session_id']),
        provider: String(s['provider']),
        title: s['title'] ? String(s['title']) : null,
        startedAt: Number(s['started_at']),
        endedAt: Number(s['ended_at']),
        model: s['model'] ? String(s['model']) : null,
        providerVersion: s['provider_version'] ? String(s['provider_version']) : null,
        kind: String(s['kind']),
        sourceFile: redactPath(String(s['source_file']), 3),
      })),
      groupingReasons: safeParse(groupingRow?.merged_from) ?? [],
      categories: Object.entries(CATEGORY_LABELS).map(([k, v]) => ({ key: k, label: v })),
      prior: CATEGORY_PRIORS[task.category],
    });
  }

  if (p.startsWith('/api/task/') && p.endsWith('/override') && method === 'POST') {
    const taskId = p.slice('/api/task/'.length, -'/override'.length);
    const b = (body ?? {}) as {
      title?: string;
      category?: TaskCategory;
      status?: TaskStatus;
      excluded?: boolean;
      hours?: number | null;
      note?: string;
    };
    ctx.db.handle
      .prepare(
        `INSERT INTO task_overrides (task_id, title, category, status, excluded, hours, note, updated_at)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET
           title=COALESCE(excluded.title, task_overrides.title),
           category=COALESCE(excluded.category, task_overrides.category),
           status=COALESCE(excluded.status, task_overrides.status),
           excluded=COALESCE(excluded.excluded, task_overrides.excluded),
           hours=excluded.hours,
           note=COALESCE(excluded.note, task_overrides.note),
           updated_at=excluded.updated_at`,
      )
      .run(
        taskId,
        b.title ?? null,
        b.category ?? null,
        b.status ?? null,
        b.excluded === undefined ? null : b.excluded ? 1 : 0,
        b.hours === undefined ? null : b.hours,
        b.note ?? null,
        Date.now(),
      );
    const task = loadTask(ctx.db, taskId);
    if (task) recomputeAround(ctx, settings, task.startedAt, task.endedAt);
    return json({ ok: true });
  }

  if (p.startsWith('/api/task/') && p.endsWith('/calibrate') && method === 'POST') {
    const taskId = p.slice('/api/task/'.length, -'/calibrate'.length);
    const task = loadTask(ctx.db, taskId);
    if (!task) return fail('Task not found.', 404);
    const b = (body ?? {}) as {
      userHours?: number;
      familiarity?: 'new' | 'some' | 'expert';
      usableFraction?: number;
      rewrote?: boolean;
      peerComparison?: 'faster' | 'similar' | 'slower';
    };
    if (typeof b.userHours !== 'number' || !(b.userHours >= 0))
      return fail('userHours must be a number.');
    const est = loadEstimates(ctx.db, [taskId]).get(taskId);
    recordCalibration(ctx.db, {
      taskId,
      category: task.category,
      estimatedHours: est?.gross.median ?? 1,
      userHours: b.userHours,
      ...(b.familiarity ? { familiarity: b.familiarity } : {}),
      ...(b.usableFraction !== undefined ? { usableFraction: b.usableFraction } : {}),
      ...(b.rewrote !== undefined ? { rewrote: b.rewrote } : {}),
      ...(b.peerComparison ? { peerComparison: b.peerComparison } : {}),
    });
    recomputeAround(ctx, settings, 0, Date.now());
    return json({ ok: true, calibration: calibrationSummary(ctx.db) });
  }

  // ---- share -------------------------------------------------------------
  if (p.startsWith('/api/share/') && method === 'GET') {
    const day = p.slice('/api/share/'.length).replace(/\.svg$/, '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail('Invalid day.');
    const opts = cardOptionsFromQuery(url);
    const data = buildCardData(ctx, day, settings, opts);
    const svg = renderCard(data, opts);
    return { status: 200, body: null, contentType: 'image/svg+xml; charset=utf-8', raw: svg };
  }

  if (p.startsWith('/api/share-preview/') && method === 'GET') {
    const day = p.slice('/api/share-preview/'.length);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return fail('Invalid day.');
    const opts = cardOptionsFromQuery(url);
    const data = buildCardData(ctx, day, settings, opts);
    return json({ exposure: describeExposure(opts, data), options: opts });
  }

  // ---- diagnostics -------------------------------------------------------
  if (p === '/api/diagnostics' && method === 'GET') {
    const health = ctx.db.handle.prepare('SELECT * FROM parser_health').all() as Record<
      string,
      unknown
    >[];
    const sources = ctx.db.handle
      .prepare('SELECT * FROM sources ORDER BY last_ingested DESC LIMIT 500')
      .all() as Record<string, unknown>[];
    const detections = await Promise.all(ctx.collectors.map((c) => c.detect()));
    return json({
      watchedDirs: ctx.collectors.flatMap((c) => c.dataDirs()),
      detections,
      health: health.map((h) => ({
        provider: String(h['provider']),
        parser: String(h['parser']),
        updatedAt: Number(h['updated_at']),
        ...(safeParse(h['payload']) as Record<string, unknown>),
      })),
      sources: sources.map((s) => ({
        path: redactPath(String(s['path']), 4),
        fullPath: String(s['path']),
        provider: String(s['provider']),
        size: Number(s['size']),
        bytesConsumed: Number(s['bytes_consumed']),
        linesConsumed: Number(s['lines_consumed']),
        eventsIngested: Number(s['events_ingested']),
        lastIngested: Number(s['last_ingested']),
        status: String(s['status']),
        note: s['note'] ? String(s['note']) : null,
      })),
      lastComputeStats: ctx.db.getConfig('lastComputeStats', null),
      externalRequests: listExternalRequests(ctx.db, 50),
      dbPath: ctx.db.file,
      dbBytes: ctx.db.sizeBytes(),
      logFile: path.join(ctx.db.dir, 'leverage.log'),
    });
  }

  if (p === '/api/methodology' && method === 'GET') {
    return json({
      benchmarkVersion: BENCHMARK_VERSION,
      sources: PRIOR_SOURCES,
      priors: Object.values(CATEGORY_PRIORS).map((pr) => ({
        ...pr,
        label: CATEGORY_LABELS[pr.category],
      })),
      calibration: calibrationSummary(ctx.db),
      calibrations: listCalibrations(ctx.db).slice(0, 50),
    });
  }

  // ---- settings & privacy -------------------------------------------------
  if (p === '/api/settings' && method === 'GET') return json(settings);

  if (p === '/api/settings' && method === 'POST') {
    const patch = (body ?? {}) as Partial<Settings>;
    const next = saveSettings(ctx.db, patch);
    clearRepoCache();
    // Scope-affecting changes invalidate every derived number.
    const scopeKeys: (keyof Settings)[] = [
      'excludedRepos',
      'excludedSessions',
      'excludedCategories',
      'providers',
      'redactMode',
      'customRedactTerms',
      'timezone',
      'semanticEnabled',
    ];
    if (scopeKeys.some((k) => k in patch)) recomputeAround(ctx, next, 0, Date.now());
    return json(next);
  }

  if (p === '/api/repos' && method === 'GET') {
    const rows = ctx.db.handle.prepare('SELECT * FROM repos ORDER BY name').all() as Record<
      string,
      unknown
    >[];
    return json(
      rows.map((r) => ({
        repoId: String(r['repo_id']),
        root: String(r['root']),
        displayPath: redactPath(String(r['root']), 3),
        name: String(r['name']),
        isGit: Number(r['is_git']) === 1,
        worktreeOf: r['worktree_of'] ? String(r['worktree_of']) : null,
        fileCount: r['file_count'] === null ? null : Number(r['file_count']),
        excluded: settings.excludedRepos.includes(String(r['root'])),
      })),
    );
  }

  if (p === '/api/privacy/inventory' && method === 'GET') {
    const counts = ctx.db.handle
      .prepare('SELECT kind, COUNT(*) n FROM events GROUP BY kind ORDER BY n DESC')
      .all() as { kind: string; n: number }[];
    const withText = (
      ctx.db.handle
        .prepare('SELECT COUNT(*) n FROM events WHERE payload LIKE \'%"text"%\'')
        .get() as { n: number }
    ).n;
    return json({
      dbPath: ctx.db.file,
      dbBytes: ctx.db.sizeBytes(),
      eventKinds: counts,
      eventsWithStoredText: withText,
      redactMode: settings.redactMode,
      retentionDays: settings.retentionDays,
      externalRequests: listExternalRequests(ctx.db, 200),
      semanticEnabled: settings.semanticEnabled,
      note: 'All values above live only in this SQLite file on this machine. Stored text is redaction-processed at ingest and capped in length. Redaction is best-effort and is documented as such.',
    });
  }

  if (p === '/api/privacy/delete' && method === 'POST') {
    const b = (body ?? {}) as { scope?: 'derived' | 'all' };
    if (b.scope === 'all') {
      ctx.db.transaction(() => {
        for (const t of [
          'task_events',
          'estimates',
          'day_metrics',
          'tasks',
          'events',
          'sessions',
          'sources',
          'repos',
          'semantic_cache',
          'parser_health',
          'git_commits',
        ]) {
          ctx.db.handle.exec(`DELETE FROM ${t}`);
        }
      });
      log.warn('all imported data deleted by user');
    } else {
      ctx.db.transaction(() => {
        for (const t of ['task_events', 'estimates', 'day_metrics', 'tasks', 'semantic_cache']) {
          ctx.db.handle.exec(`DELETE FROM ${t}`);
        }
      });
    }
    ctx.db.handle.exec('VACUUM');
    return json({ ok: true, dbBytes: ctx.db.sizeBytes() });
  }

  if (p === '/api/privacy/retention' && method === 'POST') {
    const days = Number((body as { days?: number } | undefined)?.days ?? 0);
    saveSettings(ctx.db, { retentionDays: days });
    if (days > 0) {
      const cutoff = Date.now() - days * 24 * HOUR;
      const info = ctx.db.handle.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
      return json({ ok: true, deleted: Number(info.changes) });
    }
    return json({ ok: true, deleted: 0 });
  }

  if (p === '/api/export' && method === 'GET') {
    // User-owned derived data only. No raw transcripts, no source code.
    const tasks = ctx.db.handle.prepare('SELECT * FROM tasks').all();
    const estimates = ctx.db.handle.prepare('SELECT * FROM estimates').all();
    const overrides = ctx.db.handle.prepare('SELECT * FROM task_overrides').all();
    const calibrations = ctx.db.handle.prepare('SELECT * FROM calibrations').all();
    const days = ctx.db.handle.prepare('SELECT * FROM day_metrics').all();
    return json({
      exportedAt: new Date().toISOString(),
      benchmarkVersion: BENCHMARK_VERSION,
      schema: 1,
      tasks,
      estimates,
      overrides,
      calibrations,
      dayMetrics: days,
    });
  }

  // ---- semantic ------------------------------------------------------------
  if (p === '/api/semantic/run' && method === 'POST') {
    if (!settings.semanticEnabled) return fail('Semantic analysis is disabled.', 409);
    const b = (body ?? {}) as { days?: number };
    const from = Date.now() - (b.days ?? 7) * 24 * HOUR;
    const res = await runSemanticPass(ctx.db, settings, from, Date.now());
    if (res.applied > 0) recomputeAround(ctx, settings, from, Date.now());
    return json(res);
  }

  if (p === '/api/onboard/complete' && method === 'POST') {
    saveSettings(ctx.db, { onboarded: true, ...(body as Partial<Settings>) });
    return json({ ok: true });
  }

  return fail('Not found.', 404);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export async function runIngest(
  ctx: ApiContext,
  settings: Settings,
  recompute: boolean,
): Promise<void> {
  ctx.state.ingesting = true;
  ctx.state.abort = new AbortController();
  const t0 = Date.now();
  try {
    const res = await ingest(ctx.db, {
      collectors: ctx.collectors,
      settings,
      signal: ctx.state.abort.signal,
      onProgress: (pr) => {
        ctx.state.progress = pr;
      },
    });
    ctx.state.lastIngest = {
      at: Date.now(),
      events: res.eventsIngested,
      files: res.filesParsed,
      durationMs: res.durationMs,
    };

    // Only recompute when something actually arrived, and only over the window
    // the new events fall in. A full eight-month rebuild on every rescan would
    // make keeping the dashboard open expensive for no benefit.
    if (recompute && res.eventsIngested > 0) {
      const DAY_MS = 24 * HOUR;
      const from = res.touchedFrom !== undefined ? res.touchedFrom - DAY_MS : 0;
      const to = res.touchedTo !== undefined ? res.touchedTo + DAY_MS : Date.now();
      const c = computeDerived(ctx.db, { settings, from, to });
      for (const d of c.daysTouched) computeDayMetrics(ctx.db, d, settings);
      ctx.state.lastCompute = {
        at: Date.now(),
        tasks: c.tasksBuilt,
        rejected: c.nonEngineeringRejected,
        durationMs: c.durationMs,
      };
    }
  } catch (err) {
    log.error('ingest failed', { err: String(err) });
    throw err;
  } finally {
    ctx.state.ingesting = false;
    ctx.state.progress = undefined;
    ctx.state.abort = undefined;
    log.info('ingest cycle complete', { ms: Date.now() - t0 });
  }
}

/**
 * Keep the index current while the dashboard is open.
 *
 * Interval polling rather than `fs.watch`: a rescan that finds nothing costs a
 * few file stats (tens of milliseconds), while filesystem watchers are
 * platform-inconsistent, miss events on network volumes, and fire in storms
 * while an agent is mid-write. Cheap and reliable beats clever here.
 */
export function startAutoRefresh(ctx: ApiContext): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    const settings = loadSettings(ctx.db);
    const seconds = settings.autoRefreshSeconds;
    if (seconds > 0 && !settings.paused && !ctx.state.ingesting) {
      try {
        await runIngest(ctx, settings, true);
      } catch (err) {
        log.warn('auto refresh failed; will retry', { err: String(err) });
      }
    }
    if (stopped) return;
    const next = Math.max(15, loadSettings(ctx.db).autoRefreshSeconds || 60) * 1000;
    timer = setTimeout(() => void tick(), next);
    timer.unref?.();
  };

  const first = Math.max(15, loadSettings(ctx.db).autoRefreshSeconds || 60) * 1000;
  timer = setTimeout(() => void tick(), first);
  timer.unref?.();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function recomputeAround(ctx: ApiContext, settings: Settings, from: number, to: number): void {
  const res = computeDerived(ctx.db, { settings, from, to });
  for (const d of res.daysTouched) computeDayMetrics(ctx.db, d, settings);
}

function repoNameMap(db: Db): Record<string, string> {
  const rows = db.handle.prepare('SELECT repo_id, name, alias FROM repos').all() as {
    repo_id: string;
    name: string;
    alias: string | null;
  }[];
  const out: Record<string, string> = {};
  for (const r of rows) out[r.repo_id] = r.alias ?? r.name;
  return out;
}

function cardOptionsFromQuery(url: URL): CardOptions {
  const variant = (url.searchParams.get('variant') as CardVariant) || 'headline';
  // `Number('abc')` is NaN, which `??` does not catch — an unvalidated `w`
  // would reach the SVG as width="NaN" and render nothing.
  const dim = (key: string): number | undefined => {
    const raw = url.searchParams.get(key);
    if (raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.min(4000, Math.trunc(n)) : undefined;
  };
  const width = dim('w');
  const height = dim('h');
  return {
    variant: ['headline', 'timeline', 'projects', 'weekly'].includes(variant)
      ? variant
      : 'headline',
    theme: url.searchParams.get('theme') === 'light' ? 'light' : 'dark',
    // Aliases are the default; revealing is an explicit opt-in per export.
    revealProjects: url.searchParams.get('revealProjects') === '1',
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

function buildCardData(ctx: ApiContext, day: string, settings: Settings, opts: CardOptions) {
  const metrics = loadDayMetrics(ctx.db, day) ?? emptyDayMetrics(day);
  const tasks = loadTasksForDay(ctx.db, day).filter((t) => !t.excluded);
  const events = loadEvents(ctx.db, startOfDay(day), endOfDay(day), settings);
  const steer = computeSteering(events, STEERING_BALANCED);
  const conc = computeConcurrency(computeAgentIntervals(events));
  const repoNames = repoNameMap(ctx.db);
  const weekly = trend(ctx.db, 7, settings).map((d) => ({
    day: d.day,
    verifiedHours: d.verifiedHours,
    steeringHours: d.steeringHours,
  }));
  void aliasProjects(tasks, repoNames, opts.revealProjects);
  return {
    day,
    metrics,
    tasks,
    repoNames,
    concurrency: conc.samples,
    steeringIntervals: steer.intervals,
    weekly,
  };
}

function safeParse(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
}

export function readStaticFile(
  root: string,
  urlPath: string,
): { body: Buffer; type: string } | null {
  const clean = urlPath === '/' ? '/index.html' : urlPath;
  // Path traversal guard: resolve, then require the result to stay under root.
  // The separator matters — a bare `startsWith` would also accept a sibling
  // directory whose name merely begins with root (`/app/public` vs `/app/publicX`).
  const base = path.resolve(root);
  const resolved = path.resolve(base, `.${clean}`);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  const ext = path.extname(resolved);
  const type =
    ext === '.html'
      ? 'text/html; charset=utf-8'
      : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : ext === '.css'
          ? 'text/css; charset=utf-8'
          : ext === '.svg'
            ? 'image/svg+xml'
            : ext === '.json'
              ? 'application/json'
              : 'application/octet-stream';
  return { body: fs.readFileSync(resolved), type };
}
