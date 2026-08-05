import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../../src/store/db.ts';
import { installDemoData, generateDemoEvents, DEMO_BASE } from '../../src/demo/generate.ts';
import { computeDerived } from '../../src/analytics/pipeline.ts';
import { computeDayMetrics, loadEstimates, loadTasksForDay } from '../../src/analytics/metrics.ts';
import { renderCard, DEFAULT_CARD_OPTIONS } from '../../src/share/card.ts';
import { dayKey } from '../../src/core/util.ts';
import { cleanup, settings, tmpDir } from '../helpers.ts';
import type { TaskRecord, TaskEstimate } from '../../src/core/types.ts';

/**
 * Evaluation against the synthetic fixture.
 *
 * The fixture in `src/demo/generate.ts` contains one instance of every hard
 * case: a validated feature, a subtle bug fix, a refactor, research, a failure,
 * a revert, a task carried across providers, human-edited work, a concurrent
 * pair, non-engineering chat, a boilerplate scaffold, and a resumed session
 * with replayed history.
 *
 * These assertions state what *must* be true of the output. They are written as
 * orderings and bounds rather than exact numbers, so the model can be improved
 * without rewriting the suite — and so nobody is tempted to tune the model until
 * the total looks impressive.
 */

const DAY = dayKey(DEMO_BASE);

let db: Db;
let dir: string;
let tasks: TaskRecord[];
let estimates: Map<string, TaskEstimate>;

function find(fragment: string): TaskRecord {
  const t = tasks.find((x) => x.title.toLowerCase().includes(fragment.toLowerCase()));
  assert.ok(
    t,
    `no task matching "${fragment}" — titles were:\n${tasks.map((x) => `  - ${x.title}`).join('\n')}`,
  );
  return t as TaskRecord;
}

function est(fragment: string): TaskEstimate {
  const e = estimates.get(find(fragment).taskId);
  assert.ok(e, `no estimate for "${fragment}"`);
  return e as TaskEstimate;
}

before(() => {
  dir = tmpDir('leverage-fixture-');
  db = new Db({ dir });
  installDemoData(db, DEMO_BASE);
  const s = settings();
  computeDerived(db, { settings: s });
  computeDayMetrics(db, DAY, s);
  tasks = loadTasksForDay(db, DAY).filter((t) => !t.excluded);
  estimates = loadEstimates(
    db,
    tasks.map((t) => t.taskId),
  );
});

after(() => {
  db?.close();
  cleanup(dir);
});

/* ================================================================== */

describe('fixture: task reconstruction', () => {
  test('the fixture generates a deterministic event set', () => {
    const a = generateDemoEvents(DEMO_BASE).map((e) => `${e.kind}@${e.ts}`);
    const b = generateDemoEvents(DEMO_BASE).map((e) => `${e.kind}@${e.ts}`);
    assert.deepEqual(a, b);
  });

  test('non-engineering conversation is excluded entirely', () => {
    const chat = tasks.find((t) => /dinner/i.test(t.title) || /dinner/i.test(t.intent));
    assert.equal(chat, undefined, 'the dinner conversation must not become a task');
  });

  test('a correction is merged into the task it corrects', () => {
    const reset = find('password reset');
    assert.ok(
      !tasks.some((t) => /expiry check is inverted/i.test(t.title)),
      'the correction must not be its own task',
    );
    assert.ok(reset.evidence.userInstructions >= 2, 'both instructions belong to it');
  });

  test('a task carried from Codex to Claude Code is reconstructed as one', () => {
    const migration = find('Migrate the orders table');
    assert.equal(migration.sessionIds.length, 2, 'both sessions contribute');
    assert.deepEqual([...migration.providers].sort(), ['claude-code', 'codex']);
    assert.ok(
      !tasks.some((t) => /Finish the orders currency migration/i.test(t.title)),
      'the continuation must not be a separate task',
    );
  });

  test('two genuinely unrelated concurrent tasks stay separate', () => {
    const ssr = find('server-side rendering');
    const rate = find('rate limiting');
    assert.notEqual(ssr.taskId, rate.taskId);
  });

  test('replayed history in a resumed session is not double counted', () => {
    const logging = find('log level setting');
    // The replayed prefix added 60 lines to worker.py; only the live 24+10 count.
    assert.ok(
      logging.evidence.linesAdded < 60,
      `replayed work must not be counted (got ${logging.evidence.linesAdded} lines)`,
    );
  });
});

describe('fixture: outcome verification', () => {
  test('a feature with tests passing after the last edit is validated', () => {
    assert.equal(find('password reset').status, 'completed-validated');
  });

  test('a subtle bug fix with a passing suite is validated', () => {
    assert.equal(find('Pagination returns a duplicate row').status, 'completed-validated');
  });

  test('work that was undone within the task is marked reverted', () => {
    assert.equal(find('Redis cache').status, 'reverted');
  });

  test('an implementation whose tests never pass is not completed', () => {
    const failed = find('websocket layer');
    assert.ok(
      ['failed', 'partial', 'abandoned'].includes(failed.status),
      `expected a non-completed status, got ${failed.status}`,
    );
  });

  test('a read-only investigation is exploratory, not completed', () => {
    const research = find('token refresh flow');
    assert.equal(research.status, 'exploratory');
    assert.equal(research.evidence.filesChanged, 0);
  });
});

describe('fixture: estimate ordering', () => {
  test('a validated multi-file feature outranks a one-line bug fix', () => {
    assert.ok(est('password reset').verified.median > est('Pagination returns').verified.median);
  });

  test('reverted work earns nothing', () => {
    assert.equal(est('Redis cache').verified.median, 0);
  });

  test('failed work earns far less than validated work of similar size', () => {
    const failed = est('websocket layer').verified.median;
    const shipped = est('password reset').verified.median;
    assert.ok(
      failed < shipped * 0.25,
      `failed (${failed}) must be heavily discounted vs shipped (${shipped})`,
    );
  });

  test('a 2,560-line scaffold does not outrank a tested feature', () => {
    const scaffold = find('Scaffold CRUD');
    assert.ok(scaffold.evidence.linesAdded > 2000, 'the fixture really is huge');
    assert.ok(
      est('Scaffold CRUD').verified.median < est('password reset').verified.median,
      'volume alone must not win',
    );
  });

  test('a lockfile-sized generated diff is excluded from authored lines', () => {
    const scaffold = find('Scaffold CRUD');
    assert.ok(scaffold.evidence.generatedLinesAdded >= 4000, 'the lockfile is recorded');
    assert.ok(scaffold.evidence.linesAdded < 4000, 'but it is not counted as authored');
  });

  test('shallow research earns much less than a full feature', () => {
    assert.ok(
      est('token refresh flow').verified.median < est('password reset').verified.median * 0.5,
    );
  });

  test('every task has gross ≥ accepted ≥ verified', () => {
    for (const t of tasks) {
      const e = estimates.get(t.taskId);
      assert.ok(e, `missing estimate for ${t.title}`);
      assert.ok(
        (e as TaskEstimate).gross.median >= (e as TaskEstimate).accepted.median - 1e-9,
        t.title,
      );
      assert.ok(
        (e as TaskEstimate).accepted.median >= (e as TaskEstimate).verified.median - 1e-9,
        t.title,
      );
    }
  });

  test('every estimate carries a range, a confidence, and a benchmark version', () => {
    for (const t of tasks) {
      const e = estimates.get(t.taskId) as TaskEstimate;
      assert.ok(e.verified.p10 <= e.verified.median, t.title);
      assert.ok(e.verified.median <= e.verified.p90, t.title);
      assert.ok(['high', 'medium', 'low'].includes(e.confidence), t.title);
      assert.ok(e.benchmarkVersion.startsWith('v'), t.title);
    }
  });

  test('ambiguous attribution is detected on the human-edited task', () => {
    const e = est('checkout validation');
    assert.ok(
      e.uncertaintyNotes.some((n) => /attribution/i.test(n)) || e.confidence !== 'high',
      'shared authorship must be reflected somewhere',
    );
  });
});

describe('fixture: day metrics', () => {
  test('the day totals are plausible and internally consistent', () => {
    const m = computeDayMetrics(db, DAY, settings());
    assert.ok(m.taskCount >= 10 && m.taskCount <= 16, `expected ~12 tasks, got ${m.taskCount}`);
    assert.ok(m.verifiedHours.median > 0);
    assert.ok(m.grossHours.median >= m.acceptedHours.median);
    assert.ok(m.acceptedHours.median >= m.verifiedHours.median);
    assert.ok(m.verifiedHours.p10 < m.verifiedHours.median);
    assert.ok(m.verifiedHours.median < m.verifiedHours.p90);
    assert.ok(m.acceptanceRate > 0 && m.acceptanceRate <= 1);
    assert.ok(m.verificationRate > 0 && m.verificationRate <= 1);
    assert.ok(m.reworkRate >= 0 && m.reworkRate <= 1);
    assert.ok(m.agentAutonomy >= 0 && m.agentAutonomy <= 1);
  });

  test('steering time is bounded by the day and ordered across parameterisations', () => {
    const m = computeDayMetrics(db, DAY, settings());
    assert.ok(m.steeringMs > 0, 'a person was clearly present');
    assert.ok(m.steeringMs < 24 * 3600_000, 'and cannot have steered more than a day');
    assert.ok(m.steeringLowMs <= m.steeringMs);
    assert.ok(m.steeringMs <= m.steeringHighMs);
  });

  test('concurrency is detected without inflating human time', () => {
    const m = computeDayMetrics(db, DAY, settings());
    assert.ok(m.peakConcurrency >= 2, 'the fixture contains a genuinely concurrent pair');
    assert.ok(m.agentActiveMs > m.steeringMs, 'agents worked longer than the person steered');
  });

  test('reverted and failed work shows up in the rework rate', () => {
    const m = computeDayMetrics(db, DAY, settings());
    assert.ok(m.reworkRate > 0, 'the fixture contains a revert and a failure');
  });

  test('a day has exactly one headline figure', () => {
    // There used to be three estimate modes here, ordered smallest to largest.
    // They were the same number times a constant, so the choice only ever
    // decided how flattering the headline looked. The day is deterministic now:
    // recomputing it can never hand back a different answer.
    const s = settings();
    const first = computeDayMetrics(db, DAY, s).verifiedHours.median;
    const again = computeDayMetrics(db, DAY, s).verifiedHours.median;
    assert.equal(first, again);
  });

  test('the headline is not absurd relative to the steering time', () => {
    const m = computeDayMetrics(db, DAY, settings());
    // A sanity ceiling. If leverage ever exceeds this on a 12-task day, the
    // model has a bug, not a discovery.
    assert.ok(m.outputLeverage > 1, 'agents should beat unassisted work');
    assert.ok(
      m.outputLeverage < 120,
      `leverage of ${m.outputLeverage.toFixed(0)}× is not defensible`,
    );
  });
});

describe('fixture: the dashboard tells the truth', () => {
  test('the sum of credited task hours matches the day headline', () => {
    const m = computeDayMetrics(db, DAY, settings());
    const sum = tasks.reduce((a, t) => a + (estimates.get(t.taskId)?.verified.mean ?? 0), 0);
    assert.ok(
      Math.abs(sum - m.verifiedHours.mean) < 0.01,
      `day total (${m.verifiedHours.mean}) must equal the sum of its parts (${sum})`,
    );
  });

  test('every task the day counts is inspectable', () => {
    for (const t of tasks) {
      const e = estimates.get(t.taskId) as TaskEstimate;
      assert.ok(e.factors.length > 0, `${t.title} must explain its estimate`);
      assert.ok(t.sessionIds.length > 0, `${t.title} must link back to sessions`);
    }
  });

  test('the share card exposes nothing private by default', () => {
    const m = computeDayMetrics(db, DAY, settings());
    const repoNames: Record<string, string> = {};
    for (const t of tasks) if (t.repoId) repoNames[t.repoId] = 'acme-web';
    const svg = renderCard(
      {
        day: DAY,
        metrics: m,
        tasks,
        repoNames,
        concurrency: [],
        steeringIntervals: [],
        weekly: [],
      },
      DEFAULT_CARD_OPTIONS,
    );
    assert.ok(!svg.includes('acme-web'));
    assert.ok(!svg.includes('/demo/'));
    for (const t of tasks) {
      const words = t.title.split(' ').filter((w) => w.length > 6);
      for (const w of words.slice(0, 2)) {
        assert.ok(!svg.includes(w), `task title word "${w}" leaked onto the card`);
      }
    }
  });
});
