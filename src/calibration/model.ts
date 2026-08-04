import type { TaskCategory } from '../core/types.ts';
import type { Db } from '../store/db.ts';
import type { CalibrationAdjustment } from '../estimate/model.ts';
import { clamp } from '../core/util.ts';

/**
 * Personal calibration.
 *
 * When a user answers "how long would this actually have taken you?", we learn
 * a per-category ratio between their answer and the standardised estimate.
 *
 * Two rules make this honest:
 *
 *  1. A user's correction calibrates *their* model, never the shared prior.
 *     The standardised competent-engineer view and the personalised view are
 *     stored and displayed separately and are never silently blended.
 *  2. The learned multiplier is a shrunk geometric mean. With one data point
 *     it barely moves; it approaches the observed ratio only as evidence
 *     accumulates. This prevents a single outlier from rewriting the model.
 */

export interface CalibrationEntry {
  readonly id: number;
  readonly taskId: string;
  readonly category: TaskCategory;
  readonly estimatedHours: number;
  readonly userHours: number;
  readonly familiarity?: string;
  readonly usableFraction?: number;
  readonly rewrote?: boolean;
  readonly peerComparison?: string;
  readonly createdAt: number;
}

export interface CalibrationInput {
  readonly taskId: string;
  readonly category: TaskCategory;
  readonly estimatedHours: number;
  readonly userHours: number;
  /** How familiar is the user with this repository? */
  readonly familiarity?: 'new' | 'some' | 'expert';
  /** How much of the agent's result was genuinely usable, 0–1. */
  readonly usableFraction?: number;
  /** Did the user substantially rewrite the output? */
  readonly rewrote?: boolean;
  /** Would another competent engineer take longer or less time? */
  readonly peerComparison?: 'faster' | 'similar' | 'slower';
}

export function recordCalibration(db: Db, input: CalibrationInput): void {
  db.handle
    .prepare(
      `INSERT INTO calibrations
        (task_id, category, estimated_hours, user_hours, familiarity, usable_fraction, rewrote, peer_comparison, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      input.taskId,
      input.category,
      input.estimatedHours,
      input.userHours,
      input.familiarity ?? null,
      input.usableFraction ?? null,
      input.rewrote === undefined ? null : input.rewrote ? 1 : 0,
      input.peerComparison ?? null,
      Date.now(),
    );
}

export function listCalibrations(db: Db): CalibrationEntry[] {
  const rows = db.handle
    .prepare('SELECT * FROM calibrations ORDER BY created_at DESC')
    .all() as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r['id']),
    taskId: String(r['task_id']),
    category: String(r['category']) as TaskCategory,
    estimatedHours: Number(r['estimated_hours']),
    userHours: Number(r['user_hours']),
    ...(r['familiarity'] ? { familiarity: String(r['familiarity']) } : {}),
    ...(r['usable_fraction'] !== null ? { usableFraction: Number(r['usable_fraction']) } : {}),
    ...(r['rewrote'] !== null ? { rewrote: Number(r['rewrote']) === 1 } : {}),
    ...(r['peer_comparison'] ? { peerComparison: String(r['peer_comparison']) } : {}),
    createdAt: Number(r['created_at']),
  }));
}

/**
 * Shrunk geometric-mean ratio of user-reported hours to estimated hours.
 *
 * Geometric because the underlying quantity is lognormal — averaging ratios
 * arithmetically would bias upward. Shrinkage weight `n / (n + k)` with k = 4
 * means one data point moves the multiplier only 20% of the way.
 */
export function calibrationFor(db: Db, category: TaskCategory): CalibrationAdjustment | undefined {
  const all = listCalibrations(db);
  if (all.length === 0) return undefined;

  const inCategory = all.filter(
    (c) => c.category === category && c.estimatedHours > 0 && c.userHours > 0,
  );
  const pool =
    inCategory.length >= 2
      ? inCategory
      : all.filter((c) => c.estimatedHours > 0 && c.userHours > 0);
  if (pool.length === 0) return undefined;

  let logSum = 0;
  for (const c of pool) logSum += Math.log(c.userHours / c.estimatedHours);
  const geoRatio = Math.exp(logSum / pool.length);

  const k = 4;
  const weight = pool.length / (pool.length + k);
  const multiplier = clamp(Math.exp(Math.log(geoRatio) * weight), 0.3, 3);

  return {
    multiplier,
    sampleSize: pool.length,
    categoryMatched: inCategory.length >= 2,
  };
}

export interface CalibrationSummary {
  readonly totalEntries: number;
  readonly byCategory: { category: TaskCategory; n: number; multiplier: number }[];
  readonly overallMultiplier: number;
  /** True once there is enough data for the personalised view to be meaningful. */
  readonly personalisedViewAvailable: boolean;
}

export function calibrationSummary(db: Db): CalibrationSummary {
  const all = listCalibrations(db).filter((c) => c.estimatedHours > 0 && c.userHours > 0);
  const byCat = new Map<TaskCategory, number[]>();
  for (const c of all) {
    const arr = byCat.get(c.category);
    const ratio = Math.log(c.userHours / c.estimatedHours);
    if (arr) arr.push(ratio);
    else byCat.set(c.category, [ratio]);
  }
  const byCategory = [...byCat.entries()].map(([category, ratios]) => ({
    category,
    n: ratios.length,
    multiplier: Math.exp(ratios.reduce((a, b) => a + b, 0) / ratios.length),
  }));
  const overall =
    all.length === 0
      ? 1
      : Math.exp(
          all.reduce((a, c) => a + Math.log(c.userHours / c.estimatedHours), 0) / all.length,
        );
  return {
    totalEntries: all.length,
    byCategory,
    overallMultiplier: overall,
    personalisedViewAvailable: all.length >= 3,
  };
}
