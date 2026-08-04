import type { Db } from '../store/db.ts';
import type { Settings } from '../core/config.ts';
import type { SemanticAdjustment } from '../estimate/model.ts';
import { loadTasksInRange } from '../analytics/metrics.ts';
import { createSemanticProvider, type SemanticTaskInput } from './provider.ts';
import { log } from '../core/log.ts';

/**
 * Semantic pass.
 *
 * Runs *after* the deterministic pipeline, never instead of it. It writes
 * per-task adjustments into the cache; the next `computeDerived` run picks them
 * up and applies them as one clamped factor. That ordering is deliberate: if
 * this pass never runs, or the API is unreachable, or the model returns
 * garbage, the product still produces complete deterministic estimates.
 */

const CACHE_PREFIX = 'task:';

export function readTaskAdjustment(db: Db, taskId: string): SemanticAdjustment | undefined {
  const row = db.handle
    .prepare('SELECT payload FROM semantic_cache WHERE key = ?')
    .get(`${CACHE_PREFIX}${taskId}`) as { payload: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.payload) as SemanticAdjustment;
  } catch {
    return undefined;
  }
}

function writeTaskAdjustment(db: Db, taskId: string, adj: SemanticAdjustment): void {
  db.handle
    .prepare(
      'INSERT OR REPLACE INTO semantic_cache (key, payload, model, created_at) VALUES (?,?,?,?)',
    )
    .run(`${CACHE_PREFIX}${taskId}`, JSON.stringify(adj), adj.model, Date.now());
}

export interface SemanticPassResult {
  readonly enabled: boolean;
  readonly requested: number;
  readonly applied: number;
  readonly skippedCached: number;
  readonly provider?: string;
  readonly reason?: string;
}

export async function runSemanticPass(
  db: Db,
  settings: Settings,
  from: number,
  to: number,
): Promise<SemanticPassResult> {
  const provider = createSemanticProvider(db, settings);
  if (!provider) {
    return {
      enabled: false,
      requested: 0,
      applied: 0,
      skippedCached: 0,
      reason: 'Semantic analysis is disabled.',
    };
  }

  const tasks = loadTasksInRange(db, from, to).filter((t) => !t.excluded);
  const pending = tasks.filter((t) => readTaskAdjustment(db, t.taskId) === undefined);
  const skippedCached = tasks.length - pending.length;
  if (pending.length === 0) {
    return {
      enabled: true,
      requested: 0,
      applied: 0,
      skippedCached,
      provider: provider.id,
      reason: 'All tasks already analysed; nothing was sent.',
    };
  }

  // Bounded per run: cost and exposure must both be predictable.
  const budgeted = pending.slice(0, Math.max(1, settings.semanticMaxTasksPerRun));
  const inputs: SemanticTaskInput[] = budgeted.map((t) => ({
    taskId: t.taskId,
    title: t.title,
    category: t.category,
    status: t.status,
    filesChanged: t.evidence.filesChanged,
    linesAdded: t.evidence.linesAdded,
    linesRemoved: t.evidence.linesRemoved,
    subsystems: t.evidence.subsystemsTouched,
    testsRun: t.evidence.testsRun,
    testsPassed: t.evidence.testsPassed,
    errors: t.evidence.errorsEncountered,
    userInstructions: t.evidence.userInstructions,
    instructionSummary: t.intent,
    fileBasenames: [],
  }));

  // Batched so a single failure does not lose the whole run.
  const BATCH = 10;
  let applied = 0;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    try {
      const result = await provider.analyze(batch);
      for (const [taskId, adj] of result) {
        writeTaskAdjustment(db, taskId, adj);
        applied++;
      }
    } catch (err) {
      log.warn('semantic batch failed', { err: String(err) });
    }
  }

  return { enabled: true, requested: inputs.length, applied, skippedCached, provider: provider.id };
}
