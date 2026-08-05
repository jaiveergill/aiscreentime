import type {
  ConfidenceLevel,
  DayMetrics,
  EffortDistribution,
  TaskEstimate,
  TaskRecord,
  TaskStatus,
} from '../core/types.ts';
import { HOUR, dayKey, endOfDay, startOfDay, unionLength } from '../core/util.ts';
import type { Db } from '../store/db.ts';
import type { Settings } from '../core/config.ts';
import { BENCHMARK_VERSION } from '../estimate/priors.ts';
import { lognormal, sumDistributions } from '../estimate/model.ts';
import {
  computeAgentIntervals,
  computeConcurrency,
  computeSteering,
  STEERING_BALANCED,
  STEERING_HIGH,
  STEERING_LOW,
} from '../steering/model.ts';
import { loadEvents } from './pipeline.ts';

/**
 * Shape version for cached `day_metrics` payloads.
 *
 * Bump this whenever a field is added, removed, or redefined. A cached row from
 * an older shape is discarded and recomputed rather than served, because
 * silently returning a payload missing half its fields is worse than being
 * slow — the UI renders blanks and nobody can tell why.
 */
export const METRICS_SHAPE_VERSION = 4;

const EMPTY_STATUS_COUNTS: Record<TaskStatus, number> = {
  'completed-validated': 0,
  'completed-weak-validation': 0,
  partial: 0,
  exploratory: 0,
  failed: 0,
  abandoned: 0,
  reverted: 0,
  superseded: 0,
  unknown: 0,
};

/**
 * Metrics for one day.
 *
 * Several distinct ratios are computed rather than one headline multiplier,
 * because collapsing them hides where the leverage actually comes from — and
 * because a single number invites the exact inflation this product is trying
 * to avoid.
 */
export function computeDayMetrics(db: Db, day: string, settings: Settings): DayMetrics {
  const from = startOfDay(day);
  const to = endOfDay(day);

  const tasks = loadTasksForDay(db, day);
  const included = tasks.filter((t) => !t.excluded);
  const estimates = loadEstimates(
    db,
    included.map((t) => t.taskId),
  );

  const grossParts: EffortDistribution[] = [];
  const acceptedParts: EffortDistribution[] = [];
  const verifiedParts: EffortDistribution[] = [];
  const statusCounts = { ...EMPTY_STATUS_COUNTS };
  const categoryHours: Record<string, number> = {};
  const repoHours: Record<string, number> = {};
  let confidenceSum = 0;
  let reworkHours = 0;

  for (const t of included) {
    statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
    const est = estimates.get(t.taskId);
    if (!est) continue;
    grossParts.push(est.gross);
    acceptedParts.push(est.accepted);
    verifiedParts.push(est.verified);
    confidenceSum += est.confidenceScore;
    categoryHours[t.category] = (categoryHours[t.category] ?? 0) + est.verified.median;
    if (t.repoId) repoHours[t.repoId] = (repoHours[t.repoId] ?? 0) + est.verified.median;
    if (t.status === 'reverted' || t.status === 'failed' || t.status === 'superseded') {
      reworkHours += est.gross.median;
    }
  }

  const gross = sumDistributions(grossParts);
  const accepted = sumDistributions(acceptedParts);
  const verified = sumDistributions(verifiedParts);

  // ---- steering & concurrency -------------------------------------------
  const events = loadEvents(db, from, to, settings);
  const steer = computeSteering(events, STEERING_BALANCED);
  const steerLow = computeSteering(events, STEERING_LOW);
  const steerHigh = computeSteering(events, STEERING_HIGH);
  const agentIntervals = computeAgentIntervals(events);
  const concurrency = computeConcurrency(agentIntervals);

  const wallClockSpanMs =
    events.length === 0
      ? 0
      : (events[events.length - 1] as { ts: number }).ts - (events[0] as { ts: number }).ts;

  const steeringHours = steer.totalMs / HOUR;
  const verifiedHours = verified.median;

  // ---- leverage ratios ---------------------------------------------------
  const outputLeverage = steeringHours > 0.02 ? verifiedHours / steeringHours : 0;

  // Wall-clock acceleration compares estimated conventional time against the
  // real elapsed time it actually took, not against steering time.
  const elapsedHours =
    unionLength(included.map((t) => [t.startedAt, t.endedAt] as [number, number])) / HOUR;
  const wallClockAcceleration = elapsedHours > 0.02 ? verifiedHours / elapsedHours : 0;

  // Parallelism leverage: the share of agent time that overlapped other agents.
  const parallelismLeverage =
    concurrency.totalAgentMs > 0 ? concurrency.concurrentAgentMs / concurrency.totalAgentMs : 0;

  const acceptanceRate = gross.median > 0 ? accepted.median / gross.median : 0;
  const verificationRate = accepted.median > 0 ? verified.median / accepted.median : 0;
  const reworkRate = gross.median > 0 ? reworkHours / gross.median : 0;

  // Agent autonomy: agent-active time not overlapped by human steering.
  const unattendedMs = Math.max(
    0,
    concurrency.wallClockAgentMs - overlapMs(agentIntervals, steer.intervals),
  );
  const agentAutonomy =
    concurrency.wallClockAgentMs > 0 ? unattendedMs / concurrency.wallClockAgentMs : 0;

  // Token totals follow the same inclusion rule as every other figure on the
  // day: an excluded task does not contribute. Unlike the hours these are
  // measured, not estimated — the providers report them directly.
  //
  // Output is withheld entirely once any Claude Code work is in the day. Its
  // transcripts omit thinking tokens, so the surviving figure is a fraction of
  // the real output; adding a complete Codex total to an incomplete Claude one
  // produces a number that is wrong and looks authoritative.
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCacheRead = 0;
  let tokensOutAvailable = included.length > 0;
  for (const t of included) {
    tokensIn += t.evidence.tokensIn ?? 0;
    tokensOut += t.evidence.tokensOut ?? 0;
    tokensCacheRead += t.evidence.tokensCacheRead ?? 0;
    if (t.providers.includes('claude-code')) tokensOutAvailable = false;
  }

  const avgConfidence = included.length > 0 ? confidenceSum / Math.max(1, estimates.size) : 0;
  const confidence: ConfidenceLevel =
    avgConfidence >= 0.68 ? 'high' : avgConfidence >= 0.42 ? 'medium' : 'low';

  const metrics: DayMetrics = {
    shapeVersion: METRICS_SHAPE_VERSION,
    dayKey: day,
    benchmarkVersion: BENCHMARK_VERSION,
    verifiedHours: verified,
    acceptedHours: accepted,
    grossHours: gross,
    steeringMs: steer.totalMs,
    steeringLowMs: steerLow.totalMs,
    steeringHighMs: steerHigh.totalMs,
    promptingMs: steer.promptingMs,
    llmMs: concurrency.totalAgentMs,
    agentActiveMs: concurrency.totalAgentMs,
    wallClockSpanMs,
    outputLeverage,
    wallClockAcceleration,
    parallelismLeverage,
    acceptanceRate,
    verificationRate,
    reworkRate,
    agentAutonomy,
    peakConcurrency: concurrency.peak,
    meanConcurrency: concurrency.mean,
    tokensIn,
    tokensOut,
    tokensOutAvailable,
    tokensCacheRead,
    concurrentAgentHours: concurrency.concurrentAgentMs / HOUR,
    taskCount: included.length,
    statusCounts,
    categoryHours,
    repoHours,
    projectCount: new Set(included.map((t) => t.repoId).filter(Boolean)).size,
    confidence,
    confidenceScore: avgConfidence,
  };

  db.handle
    .prepare(
      `INSERT INTO day_metrics (day_key, benchmark_version, payload, computed_at)
       VALUES (?,?,?,?)
       ON CONFLICT(day_key, benchmark_version) DO UPDATE SET
         payload = excluded.payload, computed_at = excluded.computed_at`,
    )
    .run(day, BENCHMARK_VERSION, JSON.stringify(metrics), Date.now());

  return metrics;
}

function overlapMs(
  agent: readonly { start: number; end: number }[],
  steering: readonly [number, number][],
): number {
  const parts: [number, number][] = [];
  for (const a of agent) {
    for (const [s, e] of steering) {
      const lo = Math.max(a.start, s);
      const hi = Math.min(a.end, e);
      if (hi > lo) parts.push([lo, hi]);
    }
  }
  return unionLength(parts);
}

export function loadTasksForDay(db: Db, day: string): TaskRecord[] {
  const rows = db.handle
    .prepare('SELECT * FROM tasks WHERE day_key = ? ORDER BY started_at ASC')
    .all(day) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function loadTasksInRange(db: Db, from: number, to: number): TaskRecord[] {
  const rows = db.handle
    .prepare('SELECT * FROM tasks WHERE started_at BETWEEN ? AND ? ORDER BY started_at ASC')
    .all(from, to) as Record<string, unknown>[];
  return rows.map(rowToTask);
}

export function loadTask(db: Db, taskId: string): TaskRecord | undefined {
  const row = db.handle.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
    Record<string, unknown> | undefined;
  return row ? rowToTask(row) : undefined;
}

function rowToTask(r: Record<string, unknown>): TaskRecord {
  return {
    taskId: String(r['task_id']),
    title: String(r['title']),
    intent: String(r['intent'] ?? ''),
    category: String(r['category']) as TaskRecord['category'],
    categorySource: String(r['category_source']) as TaskRecord['categorySource'],
    status: String(r['status']) as TaskStatus,
    statusSource: String(r['status_source']) as TaskRecord['statusSource'],
    ...(r['repo_id'] ? { repoId: String(r['repo_id']) } : {}),
    startedAt: Number(r['started_at']),
    endedAt: Number(r['ended_at']),
    sessionIds: safeArray(r['session_ids']),
    providers: safeArray(r['providers']),
    evidence: JSON.parse(String(r['evidence'])) as TaskRecord['evidence'],
    wallClockMs: Number(r['wall_clock_ms']),
    agentActiveMs: Number(r['agent_active_ms']),
    steeringMs: Number(r['steering_ms']),
    excluded: Number(r['excluded']) === 1,
    userEdited: Number(r['user_edited']) === 1,
    ...(r['merged_from'] ? { mergedFrom: safeArray(r['merged_from']) } : {}),
    dayKey: String(r['day_key']),
  };
}

function safeArray(v: unknown): string[] {
  try {
    const parsed = JSON.parse(String(v));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function loadEstimates(db: Db, taskIds: readonly string[]): Map<string, TaskEstimate> {
  const out = new Map<string, TaskEstimate>();
  if (taskIds.length === 0) return out;
  const stmt = db.handle.prepare(
    'SELECT task_id, payload FROM estimates WHERE benchmark_version = ? AND task_id = ?',
  );
  for (const id of taskIds) {
    const row = stmt.get(BENCHMARK_VERSION, id) as { payload: string } | undefined;
    if (!row) continue;
    try {
      out.set(id, JSON.parse(row.payload) as TaskEstimate);
    } catch {
      /* corrupt row; skip */
    }
  }
  return out;
}

export function loadDayMetrics(db: Db, day: string): DayMetrics | undefined {
  const row = db.handle
    .prepare('SELECT payload FROM day_metrics WHERE day_key = ? AND benchmark_version = ?')
    .get(day, BENCHMARK_VERSION) as { payload: string } | undefined;
  if (!row) return undefined;
  try {
    const parsed = JSON.parse(row.payload) as DayMetrics;
    // Treat an older shape as a cache miss so the caller recomputes it.
    if (parsed.shapeVersion !== METRICS_SHAPE_VERSION) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** Days that have any task at all, most recent first. */
export function activeDays(db: Db, limit = 90): string[] {
  const rows = db.handle
    .prepare('SELECT DISTINCT day_key FROM tasks ORDER BY day_key DESC LIMIT ?')
    .all(limit) as { day_key: string }[];
  return rows.map((r) => r.day_key);
}

export function emptyDayMetrics(day: string): DayMetrics {
  const zero = lognormal(0, 0.5);
  return {
    shapeVersion: METRICS_SHAPE_VERSION,
    dayKey: day,
    benchmarkVersion: BENCHMARK_VERSION,
    verifiedHours: zero,
    acceptedHours: zero,
    grossHours: zero,
    steeringMs: 0,
    steeringLowMs: 0,
    steeringHighMs: 0,
    promptingMs: 0,
    llmMs: 0,
    agentActiveMs: 0,
    wallClockSpanMs: 0,
    outputLeverage: 0,
    wallClockAcceleration: 0,
    parallelismLeverage: 0,
    acceptanceRate: 0,
    verificationRate: 0,
    reworkRate: 0,
    agentAutonomy: 0,
    peakConcurrency: 0,
    meanConcurrency: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensOutAvailable: false,
    tokensCacheRead: 0,
    concurrentAgentHours: 0,
    taskCount: 0,
    statusCounts: { ...EMPTY_STATUS_COUNTS },
    categoryHours: {},
    repoHours: {},
    projectCount: 0,
    confidence: 'low',
    confidenceScore: 0,
  };
}

/** Rolling trend of verified hours over the last N active days. */
export function trend(
  db: Db,
  days: number,
  settings: Settings,
): {
  day: string;
  verifiedHours: number;
  steeringHours: number;
  promptingHours: number;
  llmHours: number;
  leverage: number;
  taskCount: number;
}[] {
  const out: {
    day: string;
    verifiedHours: number;
    steeringHours: number;
    promptingHours: number;
    llmHours: number;
    leverage: number;
    taskCount: number;
  }[] = [];
  const today = dayKey(Date.now(), settings.timezone || undefined);
  const todayStart = startOfDay(today);
  for (let i = days - 1; i >= 0; i--) {
    const d = dayKey(todayStart - i * 24 * HOUR, settings.timezone || undefined);
    const m = loadDayMetrics(db, d) ?? emptyDayMetrics(d);
    out.push({
      day: d,
      verifiedHours: m.verifiedHours.median,
      steeringHours: m.steeringMs / HOUR,
      promptingHours: m.promptingMs / HOUR,
      llmHours: m.llmMs / HOUR,
      leverage: m.outputLeverage,
      taskCount: m.taskCount,
    });
  }
  return out;
}
