import type { NormalizedEvent, TaskEvidence, ProviderId } from '../core/types.ts';
import { hashId, uniq } from '../core/util.ts';
import { subsystemOf } from '../normalize/paths.ts';
import {
  deriveTitle,
  pathOverlap,
  similarity,
  textContainment,
  tokenWeights,
} from './similarity.ts';

/**
 * Task reconstruction.
 *
 * ## Why this is not "one prompt = one task"
 *
 * A person implementing password reset sends eight messages: the initial ask,
 * three corrections, a "now add tests", a "the test fails", a fix, and a
 * "commit it". That is one task, not eight. Conversely a single long session
 * may cover four unrelated pieces of work, and one task may be carried across
 * two providers and three sessions running in parallel worktrees.
 *
 * ## The algorithm
 *
 * 1. **Segment** each session at boundaries where the work demonstrably
 *    changed: a long idle gap, or a new instruction that is both lexically
 *    dissimilar to the segment so far *and* touches a disjoint set of files.
 *    Requiring both conditions is what stops corrections from fragmenting a
 *    task — a correction is lexically different but hits the same files.
 *
 * 2. **Merge** segments across sessions and providers when they share a
 *    repository and either overlap in files or are close in time and topic.
 *    This is what reconstructs a task carried from Codex to Claude Code, or
 *    split across two parallel agents on the same feature.
 *
 * Every decision is recorded so the task view can explain why events were
 * grouped, and the user can always merge, split, or exclude by hand.
 */

export interface ReconstructOptions {
  /** Idle gap that always starts a new segment. */
  readonly idleGapMs?: number;
  /** Lexical similarity below which a new instruction may start a segment. */
  readonly topicShiftThreshold?: number;
  /** Path overlap at or above which two segments are the same work. */
  readonly mergePathOverlap?: number;
  /** Max time between segments for a cross-session merge. */
  readonly mergeWindowMs?: number;
  /** Minimum events for a segment to become a task at all. */
  readonly minEvents?: number;
  /** How many events after an instruction to inspect for file continuity. */
  readonly lookaheadEvents?: number;
  /** Minimum number of shared file paths for a file-overlap merge. */
  readonly minSharedPaths?: number;
  /** A segment younger than this cannot be split by a topic shift. */
  readonly minSegmentMs?: number;
  /** An instruction with fewer meaningful tokens cannot start a new task. */
  readonly minTopicTokens?: number;
}

type ResolvedOptions = Required<ReconstructOptions>;

const DEFAULTS: ResolvedOptions = {
  idleGapMs: 45 * 60_000,
  topicShiftThreshold: 0.12,
  mergePathOverlap: 0.34,
  mergeWindowMs: 6 * 3600_000,
  minEvents: 2,
  lookaheadEvents: 12,
  minSharedPaths: 2,
  minSegmentMs: 3 * 60_000,
  minTopicTokens: 4,
};

export interface TaskSegment {
  readonly id: string;
  sessionIds: string[];
  providers: ProviderId[];
  repoId: string | undefined;
  events: NormalizedEvent[];
  startedAt: number;
  endedAt: number;
  /** Instruction text accumulated across the segment, for titling/classifying. */
  instructionText: string;
  paths: Set<string>;
  /** Human-readable reasons this segment was formed and merged. */
  groupingReasons: string[];
}

export function reconstructTasks(
  events: readonly NormalizedEvent[],
  opts: ReconstructOptions = {},
): TaskSegment[] {
  const o = { ...DEFAULTS, ...opts };
  const usable = events.filter((e) => !e.isReplay).sort((a, b) => a.ts - b.ts);
  if (usable.length === 0) return [];

  // ---- 1. segment within each session ------------------------------------
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of usable) {
    const arr = bySession.get(e.sessionId);
    if (arr) arr.push(e);
    else bySession.set(e.sessionId, [e]);
  }

  const segments: TaskSegment[] = [];
  for (const [sessionId, list] of bySession) {
    let current: TaskSegment | null = null;
    let currentTokens = new Map<string, number>();

    for (const e of list) {
      if (current === null) {
        current = newSegment(sessionId, e);
        currentTokens = new Map();
        segments.push(current);
      } else {
        const gap = e.ts - current.endedAt;
        let boundary = false;
        let reason = '';

        if (gap > o.idleGapMs) {
          boundary = true;
          reason = `idle gap of ${Math.round(gap / 60000)} min`;
        } else if (e.kind === 'user.instruction' && e.payload.text) {
          // A new instruction starts a new task only when the topic AND the
          // files both move on. A correction ("the expiry check is inverted")
          // is lexically unrelated to the original ask but lands in the same
          // files, so the lookahead below keeps it attached.
          const t = tokenWeights(e.payload.text);
          const sim = similarity(currentTokens, t);

          // Two guards against shredding a fast back-and-forth into dozens of
          // "tasks". Short messages ("yeah", "do it", "why?") are almost always
          // continuations, and genuine task switches do not happen every thirty
          // seconds. Without these, a conversational session produces one task
          // per message and the day total becomes meaningless.
          const substantial = t.size >= o.minTopicTokens;
          const settled = e.ts - current.startedAt >= o.minSegmentMs;

          if (substantial && settled && sim < o.topicShiftThreshold && currentTokens.size > 3) {
            const upcoming = lookaheadPaths(list, list.indexOf(e), o.lookaheadEvents);
            const continuesFiles =
              current.paths.size > 0 &&
              upcoming.size > 0 &&
              pathOverlap(current.paths, upcoming) > 0;
            if (!continuesFiles) {
              boundary = true;
              reason = `new instruction unrelated to prior work (similarity ${sim.toFixed(2)}, no shared files)`;
            }
          }
        }

        if (boundary) {
          current = newSegment(sessionId, e);
          current.groupingReasons.push(reason);
          currentTokens = new Map();
          segments.push(current);
        }
      }

      absorb(current, e);
      if (e.kind === 'user.instruction' && e.payload.text) {
        for (const [k, v] of tokenWeights(e.payload.text)) {
          currentTokens.set(k, (currentTokens.get(k) ?? 0) + v);
        }
      }
    }
  }

  // ---- 2. merge across sessions and providers ----------------------------
  const merged = mergeSegments(segments, o);

  // ---- 3. drop noise -----------------------------------------------------
  return merged.filter((s) => {
    if (s.events.length < o.minEvents) return false;
    // A segment with no instruction and no work is transport noise.
    const hasWork = s.events.some(
      (e) =>
        e.kind.startsWith('file.') ||
        e.kind === 'shell.command' ||
        e.kind === 'test.run' ||
        e.kind === 'build.run' ||
        e.kind === 'search.performed' ||
        e.kind === 'tool.invoked',
    );
    const hasInstruction = s.instructionText.trim().length > 0;
    return hasWork || hasInstruction;
  });
}

/**
 * Files touched in the next `window` events. Used to decide whether an
 * instruction continues the current task or begins a new one.
 */
function lookaheadPaths(
  list: readonly NormalizedEvent[],
  fromIndex: number,
  window: number,
): Set<string> {
  const out = new Set<string>();
  if (fromIndex < 0) return out;
  const end = Math.min(list.length, fromIndex + 1 + window);
  for (let i = fromIndex + 1; i < end; i++) {
    const e = list[i] as NormalizedEvent;
    for (const f of e.payload.files ?? []) out.add(f.path);
    for (const p of e.payload.paths ?? []) out.add(p);
  }
  return out;
}

function sharedPathCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const p of small) if (large.has(p)) n++;
  return n;
}

function newSegment(sessionId: string, e: NormalizedEvent): TaskSegment {
  return {
    id: hashId('seg', sessionId, e.ts, e.id),
    sessionIds: [sessionId],
    providers: [e.provider],
    repoId: e.repoId,
    events: [],
    startedAt: e.ts,
    endedAt: e.ts,
    instructionText: '',
    paths: new Set<string>(),
    groupingReasons: [],
  };
}

function absorb(seg: TaskSegment, e: NormalizedEvent): void {
  seg.events.push(e);
  if (e.ts < seg.startedAt) seg.startedAt = e.ts;
  if (e.ts > seg.endedAt) seg.endedAt = e.ts;
  if (!seg.repoId && e.repoId) seg.repoId = e.repoId;
  if (!seg.providers.includes(e.provider)) seg.providers.push(e.provider);
  if (!seg.sessionIds.includes(e.sessionId)) seg.sessionIds.push(e.sessionId);
  if (e.kind === 'user.instruction' && e.payload.text) {
    if (seg.instructionText.length < 6000) seg.instructionText += `${e.payload.text}\n`;
  }
  for (const f of e.payload.files ?? []) seg.paths.add(f.path);
  for (const p of e.payload.paths ?? []) seg.paths.add(p);
}

/**
 * Union-find merge over segments.
 *
 * Two segments merge when they share a repository and satisfy either:
 *  - substantial file overlap (the strongest available signal), or
 *  - temporal proximity plus lexical topic similarity.
 *
 * Segments with no repository are only merged on strong text similarity, since
 * "same directory" is not available to disambiguate them.
 */
function mergeSegments(segments: TaskSegment[], o: ResolvedOptions): TaskSegment[] {
  const n = segments.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r] as number;
    while (parent[x] !== r) {
      const next = parent[x] as number;
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const reasons = new Map<number, string[]>();
  const union = (a: number, b: number, why: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    parent[rb] = ra;
    const list = reasons.get(ra) ?? [];
    list.push(why);
    reasons.set(ra, list);
  };

  // Sorted by start time so the inner loop can break out early.
  const order = segments
    .map((_, i) => i)
    .sort(
      (x, y) => (segments[x] as TaskSegment).startedAt - (segments[y] as TaskSegment).startedAt,
    );

  for (let ii = 0; ii < order.length; ii++) {
    const i = order[ii] as number;
    const a = segments[i] as TaskSegment;
    for (let jj = ii + 1; jj < order.length; jj++) {
      const j = order[jj] as number;
      const b = segments[j] as TaskSegment;
      if (b.startedAt - a.endedAt > o.mergeWindowMs) break;
      if (
        a.sessionIds.length === 1 &&
        b.sessionIds.length === 1 &&
        a.sessionIds[0] === b.sessionIds[0]
      ) {
        continue; // same session segments were already separated deliberately
      }

      // Segments that ran at the same time are parallel workers, not a
      // continuation. Three agents editing calc.py simultaneously are three
      // delegated tasks; a task carried from Codex to Claude Code is sequential.
      // Merging on file overlap alone would collapse the former into one and
      // erase the concurrency the product exists to show.
      const overlapsInTime = a.endedAt > b.startedAt && b.endedAt > a.startedAt;
      if (overlapsInTime) continue;

      const sameRepo = a.repoId !== undefined && a.repoId === b.repoId;
      const overlap = pathOverlap(a.paths, b.paths);
      const shared = sharedPathCount(a.paths, b.paths);
      // Containment rather than Jaccard: a follow-up instruction is much
      // shorter than the original ask, and Jaccard would dilute the match.
      const textSim = textContainment(a.instructionText, b.instructionText);

      // A single shared file is a weak signal: hub files like `app.py` or
      // `index.ts` are touched by nearly every change in a project. Require
      // either several shared files, or near-total overlap backed by related
      // instructions, before concluding two sessions are the same work.
      const strongFileEvidence = shared >= o.minSharedPaths && overlap >= o.mergePathOverlap;
      const singleFileButRelated = shared >= 1 && overlap >= 0.4 && textSim >= 0.15;
      if (sameRepo && a.paths.size > 0 && (strongFileEvidence || singleFileButRelated)) {
        union(
          i,
          j,
          `shares ${shared} changed file${shared === 1 ? '' : 's'} (${Math.round(overlap * 100)}% overlap) with another session`,
        );
        continue;
      }
      if (sameRepo && textSim >= 0.45 && b.startedAt - a.endedAt < o.mergeWindowMs / 2) {
        union(
          i,
          j,
          `same repository and closely related instructions (similarity ${textSim.toFixed(2)})`,
        );
        continue;
      }
      if (!sameRepo && a.repoId === undefined && b.repoId === undefined && textSim >= 0.6) {
        union(
          i,
          j,
          `strongly related instructions across sessions (similarity ${textSim.toFixed(2)})`,
        );
      }
    }
  }

  const groups = new Map<number, TaskSegment[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const arr = groups.get(r);
    if (arr) arr.push(segments[i] as TaskSegment);
    else groups.set(r, [segments[i] as TaskSegment]);
  }

  const out: TaskSegment[] = [];
  for (const [root, members] of groups) {
    if (members.length === 1) {
      out.push(members[0] as TaskSegment);
      continue;
    }
    members.sort((x, y) => x.startedAt - y.startedAt);
    const first = members[0] as TaskSegment;
    const combined: TaskSegment = {
      id: hashId('task', ...members.map((m) => m.id)),
      sessionIds: uniq(members.flatMap((m) => m.sessionIds)),
      providers: uniq(members.flatMap((m) => m.providers)),
      repoId: members.find((m) => m.repoId)?.repoId,
      events: members.flatMap((m) => m.events).sort((x, y) => x.ts - y.ts),
      startedAt: Math.min(...members.map((m) => m.startedAt)),
      endedAt: Math.max(...members.map((m) => m.endedAt)),
      instructionText: members
        .map((m) => m.instructionText)
        .join('\n')
        .slice(0, 8000),
      paths: new Set(members.flatMap((m) => [...m.paths])),
      groupingReasons: [
        ...first.groupingReasons,
        ...(reasons.get(root) ?? []),
        `merged ${members.length} segments across ${uniq(members.flatMap((m) => m.sessionIds)).length} sessions`,
      ],
    };
    out.push(combined);
  }

  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// ---------------------------------------------------------------------------
// Evidence extraction
// ---------------------------------------------------------------------------

/**
 * Collapse a segment's events into the structured evidence used by
 * verification and estimation.
 *
 * File-level counts are deduplicated by path: editing one file eleven times is
 * one changed file, not eleven. Line counts sum the *net* effect per path with
 * a per-path cap, so an agent that rewrites the same file repeatedly cannot
 * manufacture a large diff.
 */
export function extractEvidence(seg: TaskSegment, repoRoot?: string): TaskEvidence {
  const perPath = new Map<
    string,
    { added: number; removed: number; created: boolean; deleted: boolean; generated: boolean }
  >();
  const subsystems = new Set<string>();
  const commands = new Set<string>();

  let testsRun = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let buildsRun = 0;
  let buildsPassed = 0;
  let lintRuns = 0;
  let typecheckRuns = 0;
  let errorsEncountered = 0;
  let humanInterrupts = 0;
  let userInstructions = 0;
  let retries = 0;
  let toolCalls = 0;
  let researchArtifacts = 0;
  const subagents = new Set<string>();

  for (const e of seg.events) {
    switch (e.kind) {
      case 'test.run':
        testsRun++;
        if (e.payload.outcome === 'pass') testsPassed++;
        else if (e.payload.outcome === 'fail') testsFailed++;
        break;
      case 'build.run':
        buildsRun++;
        if (e.payload.outcome === 'pass') buildsPassed++;
        break;
      case 'lint.run':
        lintRuns++;
        break;
      case 'typecheck.run':
        typecheckRuns++;
        break;
      case 'error.encountered':
        // Provider-side failures (rate limits, transport errors) are friction,
        // not evidence that the task was hard. Counting them would inflate the
        // debugging-depth factor for reasons that have nothing to do with the
        // work.
        if (
          e.payload.reason !== 'provider-error' &&
          !/usage_limit|rate_limit|quota/i.test(e.payload.reason ?? '')
        ) {
          errorsEncountered++;
        }
        break;
      case 'user.interrupt':
        humanInterrupts++;
        break;
      case 'user.instruction':
        userInstructions++;
        break;
      case 'agent.retry':
        retries++;
        break;
      case 'subagent.spawned':
        if (e.payload.subagentId) subagents.add(e.payload.subagentId);
        break;
      case 'search.performed':
      case 'web.fetched':
      case 'file.read':
        researchArtifacts++;
        break;
      default:
        break;
    }
    if (e.kind === 'tool.invoked' || e.kind === 'shell.command') toolCalls++;
    if (e.payload.command) commands.add(e.payload.command.slice(0, 120));

    for (const f of e.payload.files ?? []) {
      const cur = perPath.get(f.path) ?? {
        added: 0,
        removed: 0,
        created: false,
        deleted: false,
        generated: f.generated,
      };
      // Cap per-path contribution so repeated rewrites of one file cannot
      // inflate the diff size beyond what the file can plausibly contain.
      cur.added = Math.min(cur.added + f.linesAdded, 5000);
      cur.removed = Math.min(cur.removed + f.linesRemoved, 5000);
      if (f.changeType === 'add') cur.created = true;
      if (f.changeType === 'delete') cur.deleted = true;
      cur.generated = cur.generated || f.generated;
      perPath.set(f.path, cur);
      subsystems.add(subsystemOf(f.path, repoRoot));
    }
  }

  let linesAdded = 0;
  let linesRemoved = 0;
  let generatedLinesAdded = 0;
  let filesAdded = 0;
  let filesDeleted = 0;
  for (const [, v] of perPath) {
    if (v.generated) {
      generatedLinesAdded += v.added;
      continue; // generated content never counts as authored work
    }
    linesAdded += v.added;
    linesRemoved += v.removed;
    if (v.created) filesAdded++;
    if (v.deleted) filesDeleted++;
  }

  const realPaths = [...perPath.entries()].filter(([, v]) => !v.generated);

  return {
    filesChanged: realPaths.length,
    filesAdded,
    filesDeleted,
    linesAdded,
    linesRemoved,
    generatedLinesAdded,
    subsystemsTouched: subsystems.size,
    testsRun,
    testsPassed,
    testsFailed,
    buildsRun,
    buildsPassed,
    lintRuns,
    typecheckRuns,
    errorsEncountered,
    commits: 0,
    revertedCommits: 0,
    humanInterrupts,
    userInstructions,
    retries,
    subagentCount: subagents.size,
    toolCalls,
    distinctCommands: commands.size,
    researchArtifacts,
    filesStillPresent: 0,
    filesMissing: 0,
  };
}

/** Non-generated paths touched by a segment. */
export function segmentPaths(seg: TaskSegment): string[] {
  const out = new Set<string>();
  for (const e of seg.events) {
    for (const f of e.payload.files ?? []) if (!f.generated) out.add(f.path);
  }
  return [...out];
}

export function segmentTitle(seg: TaskSegment, fallback?: string): string {
  const text = seg.instructionText.trim();
  if (text.length > 0) return deriveTitle(text);
  if (fallback) return deriveTitle(fallback);
  const paths = segmentPaths(seg);
  if (paths.length > 0) {
    const names = paths.slice(0, 2).map((p) => p.split('/').pop());
    return deriveTitle(`Work on ${names.join(', ')}`);
  }
  return 'Untitled work';
}
