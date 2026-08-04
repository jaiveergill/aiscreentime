import type { NormalizedEvent } from '../core/types.ts';
import { mergeIntervals, unionLength } from '../core/util.ts';

/**
 * Human steering time and agent runtime.
 *
 * ## The problem
 *
 * "How long was the human working?" cannot be answered by taking the span from
 * the first prompt to the last one — that counts lunch, meetings, and sleep.
 * It also cannot be answered by summing per-session activity, because a person
 * directing four agents at once is still one person: their time must be counted
 * once, not four times.
 *
 * ## The model
 *
 * A person is *present* in a bounded window around each observable human
 * action. We build intervals from three sources and take their **union across
 * all sessions**, which structurally prevents concurrent sessions from
 * inflating human time:
 *
 *  1. **Compose** — before each human action, they were typing it. The window
 *     is capped, and further bounded by the gap since the previous event in
 *     that session (you cannot have been composing before the agent replied).
 *  2. **Tail** — immediately after acting, the person is still at the keyboard.
 *  3. **Read/review** — after an agent finishes a turn, someone reads the
 *     result. Bounded by the gap to the next human action, and capped: if the
 *     next action is four hours later, they were not reading for four hours.
 *
 * Everything else — unattended agent execution, idle terminals, background
 * processes — contributes nothing.
 *
 * The caps are the whole model, so we expose three parameterisations and report
 * a range rather than a single fake-precise number.
 */

export interface SteeringParams {
  /** Max seconds credited for composing an instruction. */
  readonly composeCapMs: number;
  /** Max seconds credited for reading an agent's output. */
  readonly readCapMs: number;
  /** Max seconds credited immediately after a human action. */
  readonly tailCapMs: number;
}

export const STEERING_LOW: SteeringParams = {
  composeCapMs: 60_000,
  readCapMs: 45_000,
  tailCapMs: 20_000,
};
export const STEERING_BALANCED: SteeringParams = {
  composeCapMs: 150_000,
  readCapMs: 120_000,
  tailCapMs: 45_000,
};
export const STEERING_HIGH: SteeringParams = {
  composeCapMs: 300_000,
  readCapMs: 240_000,
  tailCapMs: 90_000,
};

/** Events that prove a human was at the keyboard at that instant. */
const HUMAN_ANCHORS = new Set([
  'user.instruction',
  'user.interrupt',
  'approval.granted',
  'approval.denied',
]);

/** Events marking the end of an agent turn — the moment output becomes readable. */
const TURN_ENDS = new Set(['turn.completed', 'assistant.message', 'approval.requested']);

export interface SteeringResult {
  /** Disjoint intervals during which the human is modelled as steering. */
  readonly intervals: readonly [number, number][];
  readonly totalMs: number;
  /**
   * The subset of steering spent composing instructions — "prompting hours".
   *
   * Strictly narrower than `totalMs`: it excludes reading agent output and
   * reviewing results. This is the tightest defensible measure of human input,
   * and it is reported separately because the two answer different questions.
   */
  readonly promptingIntervals: readonly [number, number][];
  readonly promptingMs: number;
  readonly anchorCount: number;
}

export function computeSteering(
  events: readonly NormalizedEvent[],
  params: SteeringParams = STEERING_BALANCED,
): SteeringResult {
  // Subagent transcripts are excluded entirely. Their "user" messages are
  // prompts written by the parent *agent*, not by the person — counting them
  // as human anchors would inflate steering time in direct proportion to how
  // much work was delegated, which is exactly backwards.
  const usable = events.filter((e) => !e.isReplay && !e.isSubagent).sort((a, b) => a.ts - b.ts);
  if (usable.length === 0) {
    return { intervals: [], totalMs: 0, promptingIntervals: [], promptingMs: 0, anchorCount: 0 };
  }

  // Per-session ordering lets us bound windows by the real conversational gap.
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of usable) {
    const arr = bySession.get(e.sessionId);
    if (arr) arr.push(e);
    else bySession.set(e.sessionId, [e]);
  }

  const raw: [number, number][] = [];
  /** Compose windows only — the prompting subset. */
  const prompting: [number, number][] = [];
  let anchorCount = 0;

  for (const list of bySession.values()) {
    for (let i = 0; i < list.length; i++) {
      const e = list[i] as NormalizedEvent;

      if (HUMAN_ANCHORS.has(e.kind)) {
        anchorCount++;
        const prev = list[i - 1];
        const gapBefore = prev ? e.ts - prev.ts : params.composeCapMs;
        const compose = Math.max(5_000, Math.min(gapBefore, params.composeCapMs));
        raw.push([e.ts - compose, e.ts]);
        // Only the act of writing the instruction counts as prompting.
        if (e.kind === 'user.instruction') prompting.push([e.ts - compose, e.ts]);

        const next = list[i + 1];
        const gapAfter = next ? next.ts - e.ts : params.tailCapMs;
        const tail = Math.max(2_000, Math.min(gapAfter, params.tailCapMs));
        raw.push([e.ts, e.ts + tail]);
        continue;
      }

      if (TURN_ENDS.has(e.kind)) {
        // How long until the human does something? That bounds reading time.
        let nextHumanTs: number | undefined;
        for (let j = i + 1; j < list.length; j++) {
          const c = list[j] as NormalizedEvent;
          if (HUMAN_ANCHORS.has(c.kind)) {
            nextHumanTs = c.ts;
            break;
          }
        }
        const gap = nextHumanTs !== undefined ? nextHumanTs - e.ts : params.readCapMs;
        const read = Math.max(3_000, Math.min(gap, params.readCapMs));
        raw.push([e.ts, e.ts + read]);
      }
    }
  }

  const intervals = mergeIntervals(raw);
  const promptingIntervals = mergeIntervals(prompting);
  return {
    intervals,
    totalMs: unionLength(intervals),
    promptingIntervals,
    promptingMs: unionLength(promptingIntervals),
    anchorCount,
  };
}

// ---------------------------------------------------------------------------
// Agent runtime & concurrency
// ---------------------------------------------------------------------------

export interface AgentInterval {
  readonly sessionId: string;
  readonly start: number;
  readonly end: number;
  /** True when the provider reported the duration directly (measured). */
  readonly measured: boolean;
}

/**
 * Reconstruct intervals during which an agent was actively working.
 *
 * Both providers report turn durations directly in some versions:
 * Claude Code emits `system/turn_duration.durationMs`; Codex emits
 * `event_msg/task_complete.duration_ms`. Where present we use them verbatim —
 * these are measured, not inferred. Where absent we fall back to bridging from
 * a user instruction to the next turn-ending event, capped so that an
 * abandoned session does not report a 9-hour "agent runtime".
 */
export function computeAgentIntervals(
  events: readonly NormalizedEvent[],
  maxInferredTurnMs = 30 * 60_000,
): AgentInterval[] {
  // Subagents ARE included here: their runtime is genuine parallel agent work,
  // and each has its own session id so it forms its own concurrency channel.
  const usable = events.filter((e) => !e.isReplay).sort((a, b) => a.ts - b.ts);
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of usable) {
    const arr = bySession.get(e.sessionId);
    if (arr) arr.push(e);
    else bySession.set(e.sessionId, [e]);
  }

  const out: AgentInterval[] = [];
  for (const [sessionId, list] of bySession) {
    let pendingStart: number | undefined;
    let covered: [number, number][] = [];

    for (const e of list) {
      if (e.kind === 'turn.completed' && typeof e.payload.durationMs === 'number') {
        const dur = Math.min(e.payload.durationMs, 6 * 3600_000);
        if (dur > 0) {
          const start = e.ts - dur;
          out.push({ sessionId, start, end: e.ts, measured: true });
          covered.push([start, e.ts]);
          pendingStart = undefined;
          continue;
        }
      }
      if (e.kind === 'user.instruction') {
        pendingStart = e.ts;
        continue;
      }
      if (
        pendingStart !== undefined &&
        (e.kind === 'turn.completed' || e.kind === 'assistant.message')
      ) {
        const end = Math.min(e.ts, pendingStart + maxInferredTurnMs);
        if (end > pendingStart) {
          out.push({ sessionId, start: pendingStart, end, measured: false });
          covered.push([pendingStart, end]);
        }
        pendingStart = undefined;
      }
    }

    // Tool activity outside any recognised turn still proves the agent ran.
    const merged = mergeIntervals(covered);
    const isCovered = (t: number): boolean => merged.some(([s, e2]) => t >= s && t <= e2);
    let runStart: number | undefined;
    let runEnd: number | undefined;
    for (const e of list) {
      const isWork =
        e.kind.startsWith('tool.') ||
        e.kind.startsWith('file.') ||
        e.kind === 'shell.command' ||
        e.kind === 'test.run' ||
        e.kind === 'build.run' ||
        e.kind === 'lint.run' ||
        e.kind === 'typecheck.run';
      if (!isWork || isCovered(e.ts)) continue;
      if (runStart === undefined) {
        runStart = e.ts;
        runEnd = e.ts;
      } else if (e.ts - (runEnd as number) <= 120_000) {
        runEnd = e.ts;
      } else {
        out.push({ sessionId, start: runStart, end: (runEnd as number) + 5_000, measured: false });
        runStart = e.ts;
        runEnd = e.ts;
      }
    }
    if (runStart !== undefined && runEnd !== undefined) {
      out.push({ sessionId, start: runStart, end: runEnd + 5_000, measured: false });
    }
    covered = [];
  }

  return out.sort((a, b) => a.start - b.start);
}

export interface ConcurrencyResult {
  /** Step function of concurrent agent count over time. */
  readonly samples: { ts: number; activeAgents: number }[];
  readonly peak: number;
  /** Time-weighted mean concurrency over the period when anything was active. */
  readonly mean: number;
  /** Sum of all agent-active intervals — can exceed the wall-clock span. */
  readonly totalAgentMs: number;
  /** Union of agent-active intervals — never exceeds the wall-clock span. */
  readonly wallClockAgentMs: number;
  /** Agent-hours that overlapped with at least one other agent. */
  readonly concurrentAgentMs: number;
}

/**
 * Sweep-line concurrency.
 *
 * `totalAgentMs` and `wallClockAgentMs` are reported separately and never
 * conflated: the first is compute across workers, the second is elapsed time.
 * Reporting only the first would be dishonest; only the second would erase the
 * parallelism that is the entire point of the product.
 */
export function computeConcurrency(intervals: readonly AgentInterval[]): ConcurrencyResult {
  if (intervals.length === 0) {
    return {
      samples: [],
      peak: 0,
      mean: 0,
      totalAgentMs: 0,
      wallClockAgentMs: 0,
      concurrentAgentMs: 0,
    };
  }

  // Distinct sessions only: two intervals of the same session overlapping is
  // an artefact, not real parallelism.
  const bySession = new Map<string, [number, number][]>();
  for (const iv of intervals) {
    const arr = bySession.get(iv.sessionId);
    if (arr) arr.push([iv.start, iv.end]);
    else bySession.set(iv.sessionId, [[iv.start, iv.end]]);
  }

  const points: { t: number; d: number }[] = [];
  let totalAgentMs = 0;
  const allIntervals: [number, number][] = [];
  for (const spans of bySession.values()) {
    for (const [s, e] of mergeIntervals(spans)) {
      points.push({ t: s, d: 1 }, { t: e, d: -1 });
      totalAgentMs += e - s;
      allIntervals.push([s, e]);
    }
  }
  points.sort((a, b) => a.t - b.t || b.d - a.d);

  const samples: { ts: number; activeAgents: number }[] = [];
  let active = 0;
  let peak = 0;
  let weighted = 0;
  let activeSpan = 0;
  let concurrentAgentMs = 0;
  let prevT = points[0]?.t ?? 0;

  for (const p of points) {
    const dt = p.t - prevT;
    if (dt > 0 && active > 0) {
      weighted += active * dt;
      activeSpan += dt;
      if (active > 1) concurrentAgentMs += (active - 1) * dt;
    }
    active += p.d;
    if (active > peak) peak = active;
    prevT = p.t;
    samples.push({ ts: p.t, activeAgents: Math.max(0, active) });
  }

  return {
    samples,
    peak,
    mean: activeSpan > 0 ? weighted / activeSpan : 0,
    totalAgentMs,
    wallClockAgentMs: unionLength(allIntervals),
    concurrentAgentMs,
  };
}

/** Steering intervals restricted to a time window, e.g. one task or one day. */
export function steeringWithin(result: SteeringResult, start: number, end: number): number {
  const clipped: [number, number][] = [];
  for (const [s, e] of result.intervals) {
    const a = Math.max(s, start);
    const b = Math.min(e, end);
    if (b > a) clipped.push([a, b]);
  }
  return unionLength(clipped);
}
