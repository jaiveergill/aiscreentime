import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { MIN, T0, ev, fileChange, cleanup, tmpDir } from '../helpers.ts';
import { extractEvidence, reconstructTasks, segmentPaths } from '../../src/tasks/reconstruct.ts';
import { assessRelevance, researchDepthMultiplier } from '../../src/tasks/relevance.ts';
import { categorize } from '../../src/tasks/categorize.ts';
import { verifyOutcome } from '../../src/verify/outcome.ts';
import {
  computeAgentIntervals,
  computeConcurrency,
  computeSteering,
  steeringWithin,
  STEERING_BALANCED,
  STEERING_HIGH,
  STEERING_LOW,
} from '../../src/steering/model.ts';
import { estimateTask, lognormal, probit, sumDistributions } from '../../src/estimate/model.ts';
import { BENCHMARK_VERSION, CATEGORY_PRIORS } from '../../src/estimate/priors.ts';
import { resolveRepo, clearRepoCache } from '../../src/repo/resolve.ts';
import { classifyCommand, classifyOutcome } from '../../src/normalize/commands.ts';
import { isGeneratedPath, subsystemOf, isTestPath } from '../../src/normalize/paths.ts';
import { unionLength, mergeIntervals, roundHuman, dayKey } from '../../src/core/util.ts';
import type { TaskEvidence } from '../../src/core/types.ts';

/* ================================================================== */
/* Interval maths — the foundation of "no double counting"             */
/* ================================================================== */

describe('interval maths', () => {
  test('unionLength never double counts overlapping spans', () => {
    assert.equal(
      unionLength([
        [0, 10],
        [5, 15],
      ]),
      15,
    );
    assert.equal(
      unionLength([
        [0, 10],
        [10, 20],
      ]),
      20,
    );
    assert.equal(
      unionLength([
        [0, 10],
        [20, 30],
      ]),
      20,
    );
    assert.equal(
      unionLength([
        [0, 100],
        [10, 20],
        [30, 40],
      ]),
      100,
      'nested spans add nothing',
    );
    assert.equal(unionLength([]), 0);
    assert.equal(unionLength([[5, 5]]), 0, 'zero-length spans are dropped');
  });

  test('mergeIntervals produces a minimal disjoint set', () => {
    assert.deepEqual(
      mergeIntervals([
        [0, 5],
        [3, 8],
        [20, 25],
      ]),
      [
        [0, 8],
        [20, 25],
      ],
    );
  });

  test('roundHuman avoids fake precision at every scale', () => {
    assert.equal(roundHuman(0.123), 0.1);
    assert.equal(roundHuman(3.26), 3.5);
    assert.equal(roundHuman(27.4), 27);
    assert.equal(roundHuman(184.2), 185);
  });
});

/* ================================================================== */
/* Command & path classification                                       */
/* ================================================================== */

describe('command classification', () => {
  test('recognises test, build, lint and typecheck across ecosystems', () => {
    assert.equal(classifyCommand('pytest tests/ -x').cls, 'test');
    assert.equal(classifyCommand('cargo test --all').cls, 'test');
    assert.equal(classifyCommand('npm run test:unit').cls, 'test');
    assert.equal(classifyCommand('go test ./...').cls, 'test');
    assert.equal(classifyCommand('npm run build').cls, 'build');
    assert.equal(classifyCommand('cargo build --release').cls, 'build');
    assert.equal(classifyCommand('eslint src --fix').cls, 'lint');
    assert.equal(classifyCommand('tsc --noEmit').cls, 'typecheck');
    assert.equal(classifyCommand('mypy .').cls, 'typecheck');
  });

  test('separates git reads from git writes and never treats them as verification', () => {
    assert.equal(classifyCommand('git status').cls, 'git-read');
    assert.equal(classifyCommand('git commit -m x').cls, 'git-write');
    assert.equal(classifyCommand('git status').isVerification, false);
  });

  test('ordering: lint and typecheck beat the generic package-manager pattern', () => {
    assert.equal(classifyCommand('npm run lint').cls, 'lint');
    assert.equal(classifyCommand('npm run typecheck').cls, 'typecheck');
    assert.equal(classifyCommand('npm install').cls, 'package-manager');
  });

  test('outcome is conservative: ambiguous output is unknown, never pass', () => {
    assert.equal(classifyOutcome(0, '', ''), 'pass');
    assert.equal(classifyOutcome(1, '', ''), 'fail');
    assert.equal(classifyOutcome(undefined, '', ''), 'unknown');
    assert.equal(classifyOutcome(undefined, 'some prose about things', ''), 'unknown');
    assert.equal(classifyOutcome(undefined, '12 passed', ''), 'pass');
    assert.equal(classifyOutcome(undefined, '', 'Traceback (most recent call last):'), 'fail');
  });
});

describe('path classification', () => {
  test('generated, vendored and lockfile paths are excluded from authored work', () => {
    assert.equal(isGeneratedPath('/r/node_modules/x/index.js'), true);
    assert.equal(isGeneratedPath('/r/package-lock.json'), true);
    assert.equal(isGeneratedPath('/r/dist/bundle.js'), true);
    assert.equal(isGeneratedPath('/r/src/api.pb.go'), true);
    assert.equal(isGeneratedPath('/r/src/auth/session.ts'), false);
  });

  test('test paths are recognised across conventions', () => {
    assert.equal(isTestPath('/r/tests/test_x.py'), true);
    assert.equal(isTestPath('/r/src/auth.test.ts'), true);
    assert.equal(isTestPath('/r/src/auth_test.go'), true);
    assert.equal(isTestPath('/r/src/auth.ts'), false);
  });

  test('subsystem keys are stable and repo-relative', () => {
    assert.equal(subsystemOf('/r/src/auth/session.ts', '/r'), 'src/auth');
    assert.equal(subsystemOf('/r/api/orders/model.py', '/r'), 'api/orders');
    assert.equal(subsystemOf('/r/README.md', '/r'), '<root>');
  });
});

/* ================================================================== */
/* Steering time                                                       */
/* ================================================================== */

describe('steering time', () => {
  test('four concurrent sessions do not produce four hours of human time', () => {
    // Four sessions, all with an instruction at the same instant.
    const events = ['a', 'b', 'c', 'd'].flatMap((s) => [
      ev('user.instruction', T0, { text: 'do the thing' }, { sessionId: s }),
      ev('assistant.message', T0 + 10 * MIN, { text: 'done' }, { sessionId: s }),
    ]);
    const r = computeSteering(events, STEERING_BALANCED);
    // Union of four identical windows is one window, not four.
    const single = computeSteering(events.slice(0, 2), STEERING_BALANCED);
    assert.equal(r.totalMs, single.totalMs, 'concurrency must not multiply human time');
    assert.equal(r.anchorCount, 4, 'but all four anchors are still observed');
  });

  test('unattended agent runtime contributes nothing', () => {
    const events = [
      ev('user.instruction', T0, { text: 'go' }),
      // Four hours of tool calls with no human action at all.
      ...Array.from({ length: 40 }, (_, i) =>
        ev('shell.command', T0 + (i + 1) * 6 * MIN, { command: 'ls' }),
      ),
    ];
    const r = computeSteering(events, STEERING_BALANCED);
    assert.ok(r.totalMs < 20 * MIN, `expected a small steering total, got ${r.totalMs / MIN} min`);
  });

  test('a long absence between prompts is capped, not counted whole', () => {
    const events = [
      ev('user.instruction', T0, { text: 'first' }),
      ev('turn.completed', T0 + MIN, { durationMs: 60_000 }),
      ev('user.instruction', T0 + 8 * 3600_000, { text: 'back from lunch and a meeting' }),
    ];
    const r = computeSteering(events, STEERING_BALANCED);
    assert.ok(r.totalMs < 15 * MIN, `8 idle hours must not be counted; got ${r.totalMs / MIN} min`);
  });

  test('low, balanced and high parameterisations are ordered', () => {
    const events = [
      ev('user.instruction', T0, { text: 'x' }),
      ev('turn.completed', T0 + 5 * MIN, { durationMs: 300_000 }),
      ev('user.instruction', T0 + 20 * MIN, { text: 'y' }),
    ];
    const lo = computeSteering(events, STEERING_LOW).totalMs;
    const mid = computeSteering(events, STEERING_BALANCED).totalMs;
    const hi = computeSteering(events, STEERING_HIGH).totalMs;
    assert.ok(lo < mid && mid < hi, `expected lo<mid<hi, got ${lo} ${mid} ${hi}`);
  });

  test('steering never exceeds the wall-clock span of the activity', () => {
    const events = Array.from({ length: 30 }, (_, i) =>
      ev('user.instruction', T0 + i * MIN, { text: `msg ${i}` }, { sessionId: `s${i % 5}` }),
    );
    const r = computeSteering(events, STEERING_HIGH);
    const span = 29 * MIN;
    assert.ok(r.totalMs <= span + 10 * MIN, 'bounded by the span plus edge windows');
  });

  test('delegated subagent prompts are not counted as your steering', () => {
    // A parent agent spawning 20 subagents writes 20 "user" messages into the
    // subagent transcripts. Counting those would make steering time grow with
    // delegation — exactly backwards.
    const mine = [ev('user.instruction', T0, { text: 'go build the thing' })];
    const withDelegation = [
      ...mine,
      ...Array.from({ length: 20 }, (_, i) =>
        ev(
          'user.instruction',
          T0 + (i + 1) * MIN,
          { text: `subtask ${i}` },
          { sessionId: `s::agent-${i}` },
        ),
      ).map((e) => ({ ...e, isSubagent: true })),
    ];
    assert.equal(
      computeSteering(withDelegation).totalMs,
      computeSteering(mine).totalMs,
      'delegation must not inflate human time',
    );
  });

  test('subagent runtime still counts toward agent concurrency', () => {
    const events = ['a', 'b', 'c'].map((s, i) => ({
      ...ev(
        'turn.completed',
        T0 + (30 + i) * MIN,
        { durationMs: 1800_000 },
        { sessionId: `p::agent-${s}` },
      ),
      isSubagent: true,
    }));
    const c = computeConcurrency(computeAgentIntervals(events));
    assert.equal(c.peak, 3, 'parallel subagents are real parallel work');
  });

  test('replayed events are excluded from steering', () => {
    const real = [ev('user.instruction', T0, { text: 'x' })];
    const withReplay = [
      ...real,
      ev('user.instruction', T0 + MIN, { text: 'y' }, { isReplay: true }),
    ];
    assert.equal(computeSteering(withReplay).totalMs, computeSteering(real).totalMs);
  });

  test('steeringWithin clips to a task window', () => {
    const events = [
      ev('user.instruction', T0, { text: 'x' }),
      ev('user.instruction', T0 + 60 * MIN, { text: 'y' }),
    ];
    const r = computeSteering(events, STEERING_BALANCED);
    const clipped = steeringWithin(r, T0 - MIN, T0 + 5 * MIN);
    assert.ok(clipped > 0 && clipped < r.totalMs);
  });
});

/* ================================================================== */
/* Agent runtime & concurrency                                         */
/* ================================================================== */

describe('agent runtime and concurrency', () => {
  test('provider-reported turn durations are used verbatim and marked measured', () => {
    const events = [ev('turn.completed', T0 + 10 * MIN, { durationMs: 600_000 })];
    const iv = computeAgentIntervals(events);
    assert.equal(iv.length, 1);
    assert.equal(iv[0]?.measured, true);
    assert.equal(iv[0]?.end - iv[0]?.start, 600_000);
  });

  test('an inferred turn is capped so an abandoned session is not a 9-hour runtime', () => {
    const events = [
      ev('user.instruction', T0, { text: 'go' }),
      ev('assistant.message', T0 + 9 * 3600_000, { text: 'done' }),
    ];
    const iv = computeAgentIntervals(events);
    assert.ok((iv[0]?.end ?? 0) - (iv[0]?.start ?? 0) <= 30 * 60_000);
    assert.equal(iv[0]?.measured, false);
  });

  test('total agent time and wall-clock time are reported separately', () => {
    // Two sessions each active for a full hour, at the same time.
    const events = [
      ev('turn.completed', T0 + 60 * MIN, { durationMs: 3600_000 }, { sessionId: 'a' }),
      ev('turn.completed', T0 + 60 * MIN, { durationMs: 3600_000 }, { sessionId: 'b' }),
    ];
    const c = computeConcurrency(computeAgentIntervals(events));
    assert.equal(c.totalAgentMs, 2 * 3600_000, 'compute across workers');
    assert.equal(c.wallClockAgentMs, 3600_000, 'elapsed time');
    assert.equal(c.peak, 2);
    assert.equal(c.concurrentAgentMs, 3600_000);
  });

  test('overlapping intervals within one session are not counted as parallelism', () => {
    const events = [
      ev('turn.completed', T0 + 30 * MIN, { durationMs: 1800_000 }, { sessionId: 'a' }),
      ev('turn.completed', T0 + 40 * MIN, { durationMs: 1800_000 }, { sessionId: 'a' }),
    ];
    const c = computeConcurrency(computeAgentIntervals(events));
    assert.equal(c.peak, 1, 'a single session is never concurrent with itself');
  });

  test('peak concurrency reflects genuinely simultaneous sessions', () => {
    const events = ['a', 'b', 'c'].map((s, i) =>
      ev('turn.completed', T0 + (30 + i) * MIN, { durationMs: 1800_000 }, { sessionId: s }),
    );
    const c = computeConcurrency(computeAgentIntervals(events));
    assert.equal(c.peak, 3);
    assert.ok(c.mean > 1);
  });

  test('no activity yields zeroes rather than NaN', () => {
    const c = computeConcurrency([]);
    assert.equal(c.peak, 0);
    assert.equal(c.mean, 0);
    assert.equal(c.totalAgentMs, 0);
  });
});

/* ================================================================== */
/* Task reconstruction                                                 */
/* ================================================================== */

describe('task reconstruction', () => {
  test('a correction stays attached to the task it corrects', () => {
    const f = '/r/src/auth.ts';
    const events = [
      ev('user.instruction', T0, { text: 'Implement password reset with email tokens' }),
      ev('file.modified', T0 + 2 * MIN, { files: [fileChange(f, 'update', 100, 0)], paths: [f] }),
      // Lexically unrelated, but lands in the same file: still one task.
      ev('user.instruction', T0 + 5 * MIN, { text: 'The expiry check is inverted' }),
      ev('file.modified', T0 + 6 * MIN, { files: [fileChange(f, 'update', 4, 4)], paths: [f] }),
    ];
    const segs = reconstructTasks(events);
    assert.equal(segs.length, 1, 'corrections must not fragment a task');
  });

  test('an unrelated instruction touching different files starts a new task', () => {
    const events = [
      ev('user.instruction', T0, { text: 'Implement password reset with email tokens' }),
      ev('file.modified', T0 + MIN, {
        files: [fileChange('/r/src/auth.ts', 'update', 80, 0)],
        paths: ['/r/src/auth.ts'],
      }),
      ev('user.instruction', T0 + 5 * MIN, {
        text: 'Now optimise the image resizing pipeline for throughput',
      }),
      ev('file.modified', T0 + 6 * MIN, {
        files: [fileChange('/r/img/resize.ts', 'update', 60, 0)],
        paths: ['/r/img/resize.ts'],
      }),
    ];
    const segs = reconstructTasks(events);
    assert.equal(segs.length, 2);
  });

  test('a long idle gap always splits, even for identical instructions', () => {
    const f = '/r/src/a.ts';
    const events = [
      ev('user.instruction', T0, { text: 'same words every time' }),
      ev('file.modified', T0 + MIN, { files: [fileChange(f, 'update', 5, 1)], paths: [f] }),
      ev('user.instruction', T0 + 3 * 3600_000, { text: 'same words every time' }),
      ev('file.modified', T0 + 3 * 3600_000 + MIN, {
        files: [fileChange(f, 'update', 5, 1)],
        paths: [f],
      }),
    ];
    assert.equal(reconstructTasks(events).length, 2);
  });

  test('a lone instruction with no work at all is not a task', () => {
    assert.equal(reconstructTasks([ev('user.instruction', T0, { text: 'hello' })]).length, 0);
  });

  test('one task carried across two providers is reconstructed as one', () => {
    const shared = '/r/api/orders/model.py';
    const events = [
      ev(
        'user.instruction',
        T0,
        {
          text: 'Migrate the orders table to the new schema with a currency column and a backfill',
        },
        { sessionId: 'cx', provider: 'codex', repoId: 'R' },
      ),
      ev(
        'file.created',
        T0 + 2 * MIN,
        {
          files: [
            fileChange('/r/migrations/1.sql', 'add', 40, 0),
            fileChange(shared, 'update', 30, 5),
          ],
          paths: ['/r/migrations/1.sql', shared],
        },
        { sessionId: 'cx', provider: 'codex', repoId: 'R' },
      ),
      ev(
        'user.instruction',
        T0 + 40 * MIN,
        {
          text: 'Finish the orders currency migration, the backfill script and model still need work',
        },
        { sessionId: 'cc', provider: 'claude-code', repoId: 'R' },
      ),
      ev(
        'file.modified',
        T0 + 42 * MIN,
        {
          files: [
            fileChange(shared, 'update', 18, 6),
            fileChange('/r/scripts/backfill.py', 'add', 70, 0),
          ],
          paths: [shared, '/r/scripts/backfill.py'],
        },
        { sessionId: 'cc', provider: 'claude-code', repoId: 'R' },
      ),
    ];
    const segs = reconstructTasks(events);
    assert.equal(segs.length, 1, 'cross-provider continuation must merge');
    assert.deepEqual(segs[0]?.providers.sort(), ['claude-code', 'codex']);
    assert.equal(segs[0]?.sessionIds.length, 2);
    assert.ok(segs[0]?.groupingReasons.some((r) => r.includes('shares') || r.includes('merged')));
  });

  test('a single shared hub file is not enough to merge unrelated work', () => {
    const hub = '/r/api/app.py';
    const events = [
      ev(
        'user.instruction',
        T0,
        { text: 'Add a websocket layer so clients get live updates instead of polling' },
        { sessionId: 'a', repoId: 'R' },
      ),
      ev(
        'file.created',
        T0 + MIN,
        {
          files: [
            fileChange('/r/api/ws/server.py', 'add', 200, 0),
            fileChange(hub, 'update', 20, 2),
          ],
          paths: ['/r/api/ws/server.py', hub],
        },
        { sessionId: 'a', repoId: 'R' },
      ),
      ev(
        'user.instruction',
        T0 + 30 * MIN,
        { text: 'Add rate limiting to the public API endpoints' },
        { sessionId: 'b', repoId: 'R' },
      ),
      ev(
        'file.created',
        T0 + 31 * MIN,
        {
          files: [fileChange('/r/api/mw/rate.py', 'add', 90, 0), fileChange(hub, 'update', 14, 2)],
          paths: ['/r/api/mw/rate.py', hub],
        },
        { sessionId: 'b', repoId: 'R' },
      ),
    ];
    assert.equal(
      reconstructTasks(events).length,
      2,
      'app.py is touched by everything; it must not merge tasks',
    );
  });

  test('a rapid conversational back-and-forth is not shredded into many tasks', () => {
    // Observed on real data: short replies ("yeah", "do it", "why?") are
    // lexically unrelated to everything, so without guards each one started a
    // new task and a single session produced 163 of them.
    const f = '/r/src/app.ts';
    const replies = ['Why? why? do it', 'Yeah this makes sense', 'ok now the other one', 'hmm no'];
    const events = [
      ev('user.instruction', T0, { text: 'Build the onboarding flow with email verification' }),
      ev('file.modified', T0 + 20_000, {
        files: [fileChange(f, 'update', 40, 5)],
        paths: [f],
      }),
      ...replies.flatMap((text, i) => [
        ev('user.instruction', T0 + (i + 1) * 25_000, { text }),
        ev('file.modified', T0 + (i + 1) * 25_000 + 5_000, {
          files: [fileChange(f, 'update', 10, 2)],
          paths: [f],
        }),
      ]),
    ];
    const segs = reconstructTasks(events);
    assert.equal(segs.length, 1, `expected one task, got ${segs.length}`);
  });

  test('a substantial unrelated instruction after real time still splits', () => {
    const events = [
      ev('user.instruction', T0, { text: 'Build the onboarding flow with email verification' }),
      ev('file.modified', T0 + MIN, {
        files: [fileChange('/r/src/onboard.ts', 'update', 40, 5)],
        paths: ['/r/src/onboard.ts'],
      }),
      // Well past the settle window, substantial, and disjoint files.
      ev('user.instruction', T0 + 10 * MIN, {
        text: 'Now profile the image resizing pipeline and cut its memory footprint',
      }),
      ev('file.modified', T0 + 11 * MIN, {
        files: [fileChange('/r/img/resize.ts', 'update', 60, 8)],
        paths: ['/r/img/resize.ts'],
      }),
    ];
    assert.equal(reconstructTasks(events).length, 2, 'genuine task switches must still split');
  });

  test('concurrent agents on the same files stay separate tasks', () => {
    // Observed live: three Claude Code sessions fixing, documenting, and
    // extending the same two files in parallel merged into one task, hiding
    // the concurrency entirely.
    const f1 = '/r/calc.py';
    const f2 = '/r/test_calc.py';
    const mk = (sid: string, text: string, offset: number) => [
      ev('user.instruction', T0 + offset, { text }, { sessionId: sid, repoId: 'R' }),
      ev(
        'file.modified',
        T0 + offset + 60_000,
        {
          files: [fileChange(f1, 'update', 12, 3), fileChange(f2, 'update', 6, 1)],
          paths: [f1, f2],
        },
        { sessionId: sid, repoId: 'R' },
      ),
    ];
    const events = [
      ...mk('s1', 'Fix the off-by-one in paginate so pages do not overlap', 0),
      ...mk('s2', 'Add a docstring to every function, changing no logic', 5_000),
      ...mk('s3', 'Add safe_divide returning None on zero, with a test', 10_000),
    ];
    assert.equal(reconstructTasks(events).length, 3, 'parallel delegation must not collapse');
  });

  test('a sequential continuation on the same files still merges', () => {
    const shared = '/r/api/orders/model.py';
    const events = [
      ev(
        'user.instruction',
        T0,
        {
          text: 'Migrate the orders table to the new schema with a currency column and a backfill',
        },
        { sessionId: 'cx', provider: 'codex', repoId: 'R' },
      ),
      ev(
        'file.created',
        T0 + 2 * MIN,
        {
          files: [
            fileChange('/r/migrations/1.sql', 'add', 40, 0),
            fileChange(shared, 'update', 30, 5),
          ],
          paths: ['/r/migrations/1.sql', shared],
        },
        { sessionId: 'cx', provider: 'codex', repoId: 'R' },
      ),
      // Starts only after the first finished — a real handoff.
      ev(
        'user.instruction',
        T0 + 40 * MIN,
        {
          text: 'Finish the orders currency migration, the backfill script and model still need work',
        },
        { sessionId: 'cc', provider: 'claude-code', repoId: 'R' },
      ),
      ev(
        'file.modified',
        T0 + 42 * MIN,
        {
          files: [
            fileChange(shared, 'update', 18, 6),
            fileChange('/r/scripts/backfill.py', 'add', 70, 0),
          ],
          paths: [shared, '/r/scripts/backfill.py'],
        },
        { sessionId: 'cc', provider: 'claude-code', repoId: 'R' },
      ),
    ];
    assert.equal(reconstructTasks(events).length, 1, 'sequential handoffs must still merge');
  });

  test('replayed events never form tasks', () => {
    const events = [
      ev('user.instruction', T0, { text: 'do it' }, { isReplay: true }),
      ev(
        'file.modified',
        T0 + MIN,
        { files: [fileChange('/r/a.ts', 'update', 5, 1)], paths: ['/r/a.ts'] },
        { isReplay: true },
      ),
    ];
    assert.equal(reconstructTasks(events).length, 0);
  });
});

/* ================================================================== */
/* Evidence extraction & anti-gaming                                   */
/* ================================================================== */

describe('evidence extraction', () => {
  test('editing one file eleven times is one changed file', () => {
    const f = '/r/src/a.ts';
    const events = [
      ev('user.instruction', T0, { text: 'edit repeatedly' }),
      ...Array.from({ length: 11 }, (_, i) =>
        ev('file.modified', T0 + (i + 1) * MIN, {
          files: [fileChange(f, 'update', 10, 2)],
          paths: [f],
        }),
      ),
    ];
    const seg = reconstructTasks(events)[0];
    assert.ok(seg);
    const evd = extractEvidence(seg as never, '/r');
    assert.equal(evd.filesChanged, 1);
    assert.equal(evd.linesAdded, 110, 'line counts accumulate but the file count does not');
  });

  test('generated and lockfile content is excluded from authored line counts', () => {
    const events = [
      ev('user.instruction', T0, { text: 'install a dependency' }),
      ev('file.modified', T0 + MIN, {
        files: [
          fileChange('/r/package.json', 'update', 2, 0),
          fileChange('/r/package-lock.json', 'update', 4200, 0, true),
        ],
        paths: ['/r/package.json', '/r/package-lock.json'],
      }),
    ];
    const seg = reconstructTasks(events)[0];
    const evd = extractEvidence(seg as never, '/r');
    assert.equal(evd.filesChanged, 1, 'the lockfile is not an authored file');
    assert.equal(evd.linesAdded, 2);
    assert.equal(evd.generatedLinesAdded, 4200, 'but it is still recorded and shown');
    assert.deepEqual(segmentPaths(seg as never), ['/r/package.json']);
  });

  test('a single file cannot contribute an unbounded diff', () => {
    const f = '/r/src/a.ts';
    const events = [
      ev('user.instruction', T0, { text: 'rewrite' }),
      ...Array.from({ length: 60 }, (_, i) =>
        ev('file.modified', T0 + (i + 1) * MIN, {
          files: [fileChange(f, 'update', 500, 0)],
          paths: [f],
        }),
      ),
    ];
    const seg = reconstructTasks(events)[0];
    const evd = extractEvidence(seg as never, '/r');
    assert.ok(
      evd.linesAdded <= 5000,
      `per-path contribution must be capped, got ${evd.linesAdded}`,
    );
  });
});

/* ================================================================== */
/* Engineering-relevance gate                                          */
/* ================================================================== */

describe('engineering relevance gate', () => {
  test('a conversation with no files, commands or repository is excluded', () => {
    const events = [
      ev('user.instruction', T0, { text: 'What should I make for dinner tonight?' }),
      ev('assistant.message', T0 + MIN, { text: 'Some ideas…' }),
      ev('user.instruction', T0 + 2 * MIN, { text: 'Nice, thanks.' }),
    ];
    const seg = reconstructTasks(events)[0];
    assert.ok(seg);
    const r = assessRelevance(seg as never, false);
    assert.equal(r.verdict, 'non-engineering');
    assert.ok(r.reason.includes('excluded'));
  });

  test('source files changed is decisive on its own', () => {
    const events = [
      ev('user.instruction', T0, { text: 'tweak it' }),
      ev('file.modified', T0 + MIN, {
        files: [fileChange('/r/src/a.ts', 'update', 3, 1)],
        paths: ['/r/src/a.ts'],
      }),
    ];
    const seg = reconstructTasks(events)[0];
    assert.equal(assessRelevance(seg as never, false).verdict, 'engineering');
  });

  test('technical vocabulary alone is never sufficient', () => {
    const events = [
      ev('user.instruction', T0, {
        text: 'Explain what a database schema migration is, in general terms',
      }),
      ev('assistant.message', T0 + MIN, { text: 'A migration is…' }),
    ];
    const seg = reconstructTasks(events)[0];
    assert.equal(assessRelevance(seg as never, false).verdict, 'non-engineering');
  });

  test('research depth scales with investigative actions', () => {
    const shallow = researchDepthMultiplier([ev('search.performed', T0, {})]);
    const deep = researchDepthMultiplier(
      Array.from({ length: 30 }, (_, i) =>
        ev('file.read', T0 + i * 1000, { paths: [`/r/f${i}.ts`] }),
      ),
    );
    assert.ok(
      shallow.multiplier < 0.6,
      `a single search must not earn a full category prior (${shallow.multiplier})`,
    );
    assert.ok(deep.multiplier > shallow.multiplier * 2);
    assert.ok(deep.multiplier <= 1.5, 'and depth credit is capped');
  });
});

/* ================================================================== */
/* Categorisation                                                      */
/* ================================================================== */

describe('categorisation', () => {
  const baseEvidence = (over: Partial<TaskEvidence> = {}): TaskEvidence => ({
    filesChanged: 3,
    filesAdded: 0,
    filesDeleted: 0,
    linesAdded: 50,
    linesRemoved: 10,
    generatedLinesAdded: 0,
    subsystemsTouched: 1,
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    buildsRun: 0,
    buildsPassed: 0,
    lintRuns: 0,
    typecheckRuns: 0,
    errorsEncountered: 0,
    commits: 0,
    revertedCommits: 0,
    humanInterrupts: 0,
    userInstructions: 1,
    retries: 0,
    subagentCount: 0,
    toolCalls: 4,
    distinctCommands: 2,
    researchArtifacts: 0,
    filesStillPresent: 3,
    filesMissing: 0,
    ...over,
  });

  test('structure beats text: mostly-test files means testing', () => {
    const r = categorize({
      text: 'make the thing work',
      evidence: baseEvidence(),
      paths: ['/r/tests/a.test.ts', '/r/tests/b.test.ts', '/r/src/a.ts'],
      brownfieldRatio: 1,
      repoIsMature: true,
    });
    assert.equal(r.category, 'testing');
  });

  test('a feature that also adds tests is not a testing task', () => {
    const r = categorize({
      text: 'Implement password reset with email tokens. Add tests.',
      evidence: baseEvidence({ filesChanged: 4, filesAdded: 2 }),
      paths: [
        '/r/src/auth/reset.ts',
        '/r/src/auth/routes.ts',
        '/r/src/mail/t.ts',
        '/r/src/auth/reset.test.ts',
      ],
      brownfieldRatio: 0.5,
      repoIsMature: true,
    });
    assert.notEqual(r.category, 'testing');
  });

  test('no files changed plus exploration means research', () => {
    const r = categorize({
      text: 'How does the token refresh flow work here?',
      evidence: baseEvidence({
        filesChanged: 0,
        linesAdded: 0,
        linesRemoved: 0,
        researchArtifacts: 9,
        toolCalls: 9,
      }),
      paths: [],
      brownfieldRatio: 0,
      repoIsMature: true,
    });
    assert.equal(r.category, 'research');
  });

  test('"turned down in production" is not an incident', () => {
    const r = categorize({
      text: 'Now add a log level setting so it can be turned down in production',
      evidence: baseEvidence({ filesChanged: 2 }),
      paths: ['/r/api/worker.py', '/r/api/config.py'],
      brownfieldRatio: 1,
      repoIsMature: true,
    });
    assert.notEqual(r.category, 'incident-investigation');
  });

  test('a real incident is recognised', () => {
    const r = categorize({
      text: 'Production is down, checkout returns 500s. Investigate the outage.',
      evidence: baseEvidence({ errorsEncountered: 5 }),
      paths: ['/r/api/checkout.py'],
      brownfieldRatio: 1,
      repoIsMature: true,
    });
    assert.equal(r.category, 'incident-investigation');
  });

  test('confidence reflects the margin over the runner-up', () => {
    const clear = categorize({
      text: 'Production outage, sev1, page the on-call',
      evidence: baseEvidence(),
      paths: ['/r/a.py'],
      brownfieldRatio: 1,
      repoIsMature: true,
    });
    const murky = categorize({
      text: 'do the thing',
      evidence: baseEvidence(),
      paths: ['/r/a.py'],
      brownfieldRatio: 1,
      repoIsMature: true,
    });
    assert.ok(clear.confidence > murky.confidence);
  });
});

/* ================================================================== */
/* Verification                                                        */
/* ================================================================== */

describe('outcome verification', () => {
  const evidence = (over: Partial<TaskEvidence> = {}): TaskEvidence => ({
    filesChanged: 2,
    filesAdded: 0,
    filesDeleted: 0,
    linesAdded: 40,
    linesRemoved: 10,
    generatedLinesAdded: 0,
    subsystemsTouched: 1,
    testsRun: 0,
    testsPassed: 0,
    testsFailed: 0,
    buildsRun: 0,
    buildsPassed: 0,
    lintRuns: 0,
    typecheckRuns: 0,
    errorsEncountered: 0,
    commits: 0,
    revertedCommits: 0,
    humanInterrupts: 0,
    userInstructions: 1,
    retries: 0,
    subagentCount: 0,
    toolCalls: 3,
    distinctCommands: 2,
    researchArtifacts: 0,
    filesStillPresent: 2,
    filesMissing: 0,
    ...over,
  });

  test('tests passing after the final edit yields completed-validated', () => {
    const r = verifyOutcome({
      events: [
        ev('file.modified', T0, {
          files: [fileChange('/r/a.ts', 'update', 20, 2)],
          paths: ['/r/a.ts'],
        }),
        ev('test.run', T0 + MIN, { outcome: 'pass', command: 'npm test' }),
      ],
      evidence: evidence({ testsRun: 1, testsPassed: 1 }),
      paths: ['/r/a.ts'],
      repoIsGit: false,
      taskStart: T0,
      taskEnd: T0 + 2 * MIN,
      skipFsChecks: true,
    });
    assert.equal(r.status, 'completed-validated');
    assert.ok(r.verificationFactor >= 0.85, 'passing tests earn a high verification factor');
    assert.ok(
      r.verificationFactor < 1,
      'but a single signal is not the strongest available standard',
    );
  });

  test('multiple independent validation signals earn more than one', () => {
    const mk = (extra: Partial<TaskEvidence>, events: ReturnType<typeof ev>[]) =>
      verifyOutcome({
        events,
        evidence: evidence({ testsRun: 1, testsPassed: 1, ...extra }),
        paths: ['/r/a.ts'],
        repoIsGit: false,
        taskStart: T0,
        taskEnd: T0 + 5 * MIN,
        skipFsChecks: true,
      });
    const edit = ev('file.modified', T0, {
      files: [fileChange('/r/a.ts', 'update', 20, 2)],
      paths: ['/r/a.ts'],
    });
    const one = mk({}, [edit, ev('test.run', T0 + MIN, { outcome: 'pass', command: 'npm test' })]);
    const many = mk({ typecheckRuns: 1, lintRuns: 1 }, [
      edit,
      ev('test.run', T0 + MIN, { outcome: 'pass', command: 'npm test' }),
      ev('typecheck.run', T0 + 2 * MIN, { outcome: 'pass', command: 'tsc' }),
      ev('lint.run', T0 + 3 * MIN, { outcome: 'pass', command: 'eslint' }),
    ]);
    assert.ok(many.verificationFactor > one.verificationFactor);
  });

  test('a test that passed BEFORE the last edit does not validate it', () => {
    const r = verifyOutcome({
      events: [
        ev('test.run', T0, { outcome: 'pass', command: 'npm test' }),
        ev('file.modified', T0 + MIN, {
          files: [fileChange('/r/a.ts', 'update', 20, 2)],
          paths: ['/r/a.ts'],
        }),
      ],
      evidence: evidence({ testsRun: 1, testsPassed: 1 }),
      paths: ['/r/a.ts'],
      repoIsGit: false,
      taskStart: T0,
      taskEnd: T0 + 2 * MIN,
      skipFsChecks: true,
    });
    assert.notEqual(r.status, 'completed-validated');
  });

  test('a failing verification after the last edit is not completed', () => {
    const r = verifyOutcome({
      events: [
        ev('file.modified', T0, {
          files: [fileChange('/r/a.ts', 'update', 200, 0)],
          paths: ['/r/a.ts'],
        }),
        ev('test.run', T0 + MIN, { outcome: 'fail', command: 'pytest' }),
      ],
      evidence: evidence({ testsRun: 1, testsFailed: 1, errorsEncountered: 2 }),
      paths: ['/r/a.ts'],
      repoIsGit: false,
      taskStart: T0,
      taskEnd: T0 + 2 * MIN,
      skipFsChecks: true,
    });
    assert.equal(r.status, 'partial');
    assert.ok(r.completionFactor < 1);
  });

  test('create-then-delete inside one task is a revert and earns nothing', () => {
    const r = verifyOutcome({
      events: [
        ev('file.created', T0, {
          files: [fileChange('/r/cache.ts', 'add', 128, 0)],
          paths: ['/r/cache.ts'],
        }),
        ev('test.run', T0 + MIN, { outcome: 'pass', command: 'npm test' }),
        ev('user.instruction', T0 + 5 * MIN, {
          text: 'Actually revert that, undo the whole thing',
        }),
        ev('file.deleted', T0 + 6 * MIN, {
          files: [fileChange('/r/cache.ts', 'delete', 0, 128)],
          paths: ['/r/cache.ts'],
        }),
      ],
      evidence: evidence({ testsRun: 1, testsPassed: 1 }),
      paths: ['/r/cache.ts'],
      repoIsGit: false,
      taskStart: T0,
      taskEnd: T0 + 7 * MIN,
      skipFsChecks: true,
    });
    assert.equal(r.status, 'reverted');
    assert.equal(r.completionFactor, 0);
    assert.equal(r.verificationFactor, 0);
  });

  test('an agent self-report alone can never produce a validated status', () => {
    const r = verifyOutcome({
      events: [
        ev('file.modified', T0, {
          files: [fileChange('/r/a.ts', 'update', 300, 0)],
          paths: ['/r/a.ts'],
        }),
        ev('assistant.message', T0 + MIN, {
          text: 'Done! Everything works perfectly and all tests pass.',
        }),
      ],
      evidence: evidence(),
      paths: ['/r/a.ts'],
      repoIsGit: false,
      taskStart: T0,
      taskEnd: T0 + 2 * MIN,
      skipFsChecks: true,
    });
    assert.notEqual(r.status, 'completed-validated');
    assert.ok(r.verificationFactor < 1);
    assert.ok(r.signals.some((s) => s.key === 'no-verification'));
  });

  test('human edits to the same files mark attribution ambiguous and discount it', () => {
    const withHuman = verifyOutcome({
      events: [
        ev('file.modified', T0, {
          files: [fileChange('/r/a.ts', 'update', 40, 10)],
          paths: ['/r/a.ts'],
        }),
        ev('file.modified', T0 + MIN, {
          files: [fileChange('/r/a.ts', 'update', 8, 3)],
          paths: ['/r/a.ts'],
          reason: 'human-edit',
        }),
        ev('typecheck.run', T0 + 2 * MIN, { outcome: 'pass', command: 'tsc' }),
      ],
      evidence: evidence({ typecheckRuns: 1 }),
      paths: ['/r/a.ts'],
      repoIsGit: true,
      taskStart: T0,
      taskEnd: T0 + 3 * MIN,
      skipFsChecks: true,
    });
    assert.equal(withHuman.attributionAmbiguous, true);
    assert.ok(withHuman.verificationFactor < 1);
  });

  test('an unreachable project directory does not turn every task into a failure', () => {
    const r = verifyOutcome({
      events: [
        ev('file.created', T0, {
          files: [fileChange('/definitely/missing/a.ts', 'add', 20, 0)],
          paths: ['/definitely/missing/a.ts'],
        }),
      ],
      evidence: evidence(),
      paths: ['/definitely/missing/a.ts'],
      repoRoot: '/definitely/missing',
      repoIsGit: false,
      taskStart: T0,
      taskEnd: T0 + MIN,
    });
    assert.notEqual(r.status, 'failed');
    assert.ok(r.signals.some((s) => s.key === 'tree-unreachable'));
  });

  test('files that vanished from a reachable tree count as failure', () => {
    const dir = tmpDir();
    try {
      const gone = path.join(dir, 'gone.ts');
      const r = verifyOutcome({
        events: [
          ev('file.created', T0, { files: [fileChange(gone, 'add', 20, 0)], paths: [gone] }),
        ],
        evidence: evidence(),
        paths: [gone],
        repoRoot: dir,
        repoIsGit: false,
        taskStart: T0,
        taskEnd: T0 + MIN,
      });
      assert.equal(r.status, 'failed');
      assert.equal(r.filesMissing, 1);
    } finally {
      cleanup(dir);
    }
  });

  test('partial persistence scales completion continuously', () => {
    const dir = tmpDir();
    try {
      const kept = path.join(dir, 'kept.ts');
      const gone = path.join(dir, 'gone.ts');
      fs.writeFileSync(kept, 'x');
      const r = verifyOutcome({
        events: [
          ev('file.created', T0, {
            files: [fileChange(kept, 'add', 20, 0), fileChange(gone, 'add', 20, 0)],
            paths: [kept, gone],
          }),
          ev('test.run', T0 + MIN, { outcome: 'pass', command: 'npm test' }),
        ],
        evidence: evidence({ testsRun: 1, testsPassed: 1 }),
        paths: [kept, gone],
        repoRoot: dir,
        repoIsGit: false,
        taskStart: T0,
        taskEnd: T0 + 2 * MIN,
      });
      assert.ok(r.completionFactor > 0 && r.completionFactor < 1);
      assert.ok(r.signals.some((s) => s.key === 'partial-survival'));
    } finally {
      cleanup(dir);
    }
  });
});

/* ================================================================== */
/* Estimation                                                          */
/* ================================================================== */

describe('lognormal machinery', () => {
  test('probit matches known normal quantiles', () => {
    assert.ok(Math.abs(probit(0.5)) < 1e-9);
    assert.ok(Math.abs(probit(0.975) - 1.959964) < 1e-4);
    assert.ok(Math.abs(probit(0.025) + 1.959964) < 1e-4);
    assert.ok(Math.abs(probit(0.001) + 3.090232) < 1e-4);
    assert.throws(() => probit(0));
    assert.throws(() => probit(1));
  });

  test('a lognormal is right-skewed with the median between p10 and p90', () => {
    const d = lognormal(4, 0.7);
    assert.equal(d.p50, 4);
    assert.ok(d.p10 < 4 && 4 < d.p90);
    assert.ok(d.mean > d.median, 'right skew: mean exceeds median');
    assert.ok(d.p90 - d.p50 > d.p50 - d.p10, 'the upper tail is longer');
  });

  test('wider sigma widens the interval without moving the median', () => {
    const tight = lognormal(4, 0.45);
    const wide = lognormal(4, 1.2);
    assert.equal(tight.median, wide.median);
    assert.ok(wide.p90 > tight.p90 && wide.p10 < tight.p10);
  });

  test('summing distributions preserves the total mean', () => {
    const parts = [lognormal(2, 0.6), lognormal(3, 0.8), lognormal(1, 0.5)];
    const total = sumDistributions(parts);
    const expected = parts.reduce((a, d) => a + d.mean, 0);
    assert.ok(Math.abs(total.mean - expected) < 1e-6);
    assert.ok(total.p10 < total.median && total.median < total.p90);
  });

  test('summing nothing yields zero, not NaN', () => {
    const t = sumDistributions([]);
    assert.equal(t.median, 0);
    assert.ok(Number.isFinite(t.p90));
  });
});

describe('counterfactual estimation', () => {
  const evidence = (over: Partial<TaskEvidence> = {}): TaskEvidence => ({
    filesChanged: 4,
    filesAdded: 1,
    filesDeleted: 0,
    linesAdded: 200,
    linesRemoved: 30,
    generatedLinesAdded: 0,
    subsystemsTouched: 2,
    testsRun: 2,
    testsPassed: 2,
    testsFailed: 0,
    buildsRun: 0,
    buildsPassed: 0,
    lintRuns: 0,
    typecheckRuns: 1,
    errorsEncountered: 1,
    commits: 1,
    revertedCommits: 0,
    humanInterrupts: 0,
    userInstructions: 2,
    retries: 0,
    subagentCount: 0,
    toolCalls: 12,
    distinctCommands: 6,
    researchArtifacts: 3,
    filesStillPresent: 4,
    filesMissing: 0,
    ...over,
  });

  const verification = (over: Record<string, unknown> = {}) =>
    ({
      status: 'completed-validated',
      completionFactor: 1,
      verificationFactor: 1,
      filesStillPresent: 4,
      filesMissing: 0,
      signals: [],
      attributionAmbiguous: false,
      ...over,
    }) as never;

  const base = {
    taskId: 't1',
    category: 'feature-brownfield' as const,
    categoryConfidence: 0.8,
    mode: 'balanced' as const,
    repoIsGit: true,
    languageCount: 1,
    touchesMigration: false,
    touchesInfra: false,
  };

  test('produces gross ≥ accepted ≥ verified, with the headline on verified', () => {
    const e = estimateTask({
      ...base,
      evidence: evidence(),
      verification: verification({ completionFactor: 0.5, verificationFactor: 0.7 }),
    });
    assert.ok(e.gross.median >= e.accepted.median);
    assert.ok(e.accepted.median >= e.verified.median);
    assert.ok(Math.abs(e.accepted.median - e.gross.median * 0.5) < 1e-9);
    assert.ok(Math.abs(e.verified.median - e.accepted.median * 0.7) < 1e-9);
  });

  test('reverted work contributes zero verified hours but retains its gross estimate', () => {
    const e = estimateTask({
      ...base,
      evidence: evidence(),
      verification: verification({
        status: 'reverted',
        completionFactor: 0,
        verificationFactor: 0,
      }),
    });
    assert.ok(e.gross.median > 0, 'the attempt is still recorded');
    assert.equal(e.verified.median, 0, 'but nothing is credited');
  });

  test('a 5,000-line failure does not out-score a 20-line validated fix', () => {
    const big = estimateTask({
      ...base,
      category: 'feature-greenfield',
      evidence: evidence({
        filesChanged: 12,
        linesAdded: 5000,
        testsRun: 0,
        testsPassed: 0,
        typecheckRuns: 0,
        errorsEncountered: 4,
      }),
      verification: verification({
        status: 'failed',
        completionFactor: 0.15,
        verificationFactor: 0.3,
        filesStillPresent: 0,
        filesMissing: 12,
      }),
    });
    const small = estimateTask({
      ...base,
      category: 'debugging',
      evidence: evidence({
        filesChanged: 1,
        filesAdded: 0,
        linesAdded: 20,
        linesRemoved: 6,
        subsystemsTouched: 1,
      }),
      verification: verification(),
    });
    assert.ok(
      small.verified.median > big.verified.median,
      `precise validated fix (${small.verified.median.toFixed(2)}h) must beat a failed dump (${big.verified.median.toFixed(2)}h)`,
    );
  });

  test('diff size is strongly sublinear', () => {
    const smallDiff = estimateTask({
      ...base,
      evidence: evidence({ linesAdded: 50 }),
      verification: verification(),
    });
    const hugeDiff = estimateTask({
      ...base,
      evidence: evidence({ linesAdded: 5000 }),
      verification: verification(),
    });
    const ratio = hugeDiff.gross.median / smallDiff.gross.median;
    assert.ok(
      ratio < 3,
      `100× the lines must not be anywhere near 100× the estimate (got ${ratio.toFixed(2)}×)`,
    );
    assert.ok(ratio > 1, 'but more code is still more work');
  });

  test('token counts and tool calls are not inputs to the estimate', () => {
    const a = estimateTask({
      ...base,
      evidence: evidence({ toolCalls: 5 }),
      verification: verification(),
    });
    const b = estimateTask({
      ...base,
      evidence: evidence({ toolCalls: 5000 }),
      verification: verification(),
    });
    assert.equal(a.gross.median, b.gross.median, 'tool-call volume must not move the number');
  });

  test('boilerplate-shaped output is discounted', () => {
    const scaffold = estimateTask({
      ...base,
      category: 'project-setup',
      evidence: evidence({
        filesChanged: 8,
        filesAdded: 8,
        linesAdded: 2560,
        linesRemoved: 0,
        subsystemsTouched: 1,
        testsRun: 0,
        errorsEncountered: 0,
      }),
      verification: verification({ status: 'completed-weak-validation', verificationFactor: 0.7 }),
    });
    assert.ok(scaffold.factors.some((f) => f.key === 'boilerplate' && f.multiplier < 1));
    assert.ok(
      scaffold.verified.median < 4,
      `2,560 scaffolded lines must not read as a day of work (${scaffold.verified.median})`,
    );
  });

  test('agent retry loops do not inflate difficulty', () => {
    const looping = estimateTask({
      ...base,
      evidence: evidence({ errorsEncountered: 20, distinctCommands: 2 }),
      verification: verification(),
    });
    const genuine = estimateTask({
      ...base,
      evidence: evidence({ errorsEncountered: 20, distinctCommands: 18 }),
      verification: verification(),
    });
    assert.ok(looping.gross.median < genuine.gross.median);
    assert.ok(looping.uncertaintyNotes.some((n) => n.includes('looped')));
  });

  test('a large estimate with thin evidence is capped and flagged', () => {
    const e = estimateTask({
      ...base,
      category: 'migration',
      evidence: evidence({
        filesChanged: 30,
        linesAdded: 4000,
        subsystemsTouched: 8,
        testsRun: 0,
        testsPassed: 0,
        typecheckRuns: 0,
        commits: 0,
      }),
      verification: verification({
        status: 'unknown',
        verificationFactor: 0.45,
        filesStillPresent: 0,
        filesMissing: 30,
      }),
      repoFileCount: 20000,
      touchesMigration: true,
      mode: 'upper-range',
    });
    assert.ok(
      e.factors.some((f) => f.key === 'extreme-guard'),
      'the guard must engage',
    );
    assert.equal(e.confidence, 'low');
  });

  test('modes are ordered and conservative is the smallest', () => {
    const mk = (mode: 'conservative' | 'balanced' | 'upper-range') =>
      estimateTask({ ...base, mode, evidence: evidence(), verification: verification() }).verified
        .median;
    assert.ok(mk('conservative') < mk('balanced'));
    assert.ok(mk('balanced') < mk('upper-range'));
  });

  test('every factor is named, bounded and explained', () => {
    const e = estimateTask({
      ...base,
      evidence: evidence(),
      verification: verification(),
      repoFileCount: 4000,
    });
    assert.ok(e.factors.length > 0);
    for (const f of e.factors) {
      assert.ok(f.label.length > 0, 'factors are displayable');
      assert.ok(f.rationale.length > 20, `factor ${f.key} must explain itself`);
      assert.ok(
        f.multiplier > 0.2 && f.multiplier < 4,
        `factor ${f.key} must be bounded (${f.multiplier})`,
      );
    }
  });

  test('the benchmark version is recorded on every estimate', () => {
    const e = estimateTask({ ...base, evidence: evidence(), verification: verification() });
    assert.equal(e.benchmarkVersion, BENCHMARK_VERSION);
  });

  test('a user override replaces the model entirely and is labelled', () => {
    const e = estimateTask({
      ...base,
      evidence: evidence(),
      verification: verification(),
      userOverrideHours: 9,
    });
    assert.equal(e.verified.median, 9);
    assert.equal(e.userOverrideHours, 9);
    assert.equal(e.confidence, 'high');
    assert.equal(e.factors[0]?.epistemics, 'user-corrected');
  });

  test('calibration shrinks toward the user with evidence, not on one data point', () => {
    const one = estimateTask({
      ...base,
      evidence: evidence(),
      verification: verification(),
      calibration: { multiplier: 2, sampleSize: 1, categoryMatched: true },
    });
    const many = estimateTask({
      ...base,
      evidence: evidence(),
      verification: verification(),
      calibration: { multiplier: 2, sampleSize: 20, categoryMatched: true },
    });
    const none = estimateTask({ ...base, evidence: evidence(), verification: verification() });
    assert.ok(one.gross.median > none.gross.median);
    assert.ok(many.gross.median > one.gross.median, 'more calibration data moves further');
    assert.equal(many.calibrated, true);
  });

  test('the semantic layer can never dominate the estimate', () => {
    const none = estimateTask({ ...base, evidence: evidence(), verification: verification() });
    const extreme = estimateTask({
      ...base,
      evidence: evidence(),
      verification: verification(),
      semantic: {
        complexityMultiplier: 100,
        boilerplateFraction: 0,
        rationale: 'unbounded claim',
        model: 'test',
      },
    });
    assert.ok(extreme.gross.median <= none.gross.median * 1.7, 'clamped to at most +60%');
    assert.equal(extreme.semanticUsed, true);
  });

  test('research tasks credit depth of investigation, not just the category prior', () => {
    const shallow = estimateTask({
      ...base,
      category: 'research',
      evidence: evidence({ filesChanged: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 1 }),
      verification: verification({ status: 'exploratory', verificationFactor: 0.6 }),
      researchDepth: { multiplier: 0.25, artifacts: 0 },
    });
    const deep = estimateTask({
      ...base,
      category: 'research',
      evidence: evidence({ filesChanged: 0, linesAdded: 0, linesRemoved: 0, toolCalls: 40 }),
      verification: verification({ status: 'exploratory', verificationFactor: 0.6 }),
      researchDepth: { multiplier: 1.4, artifacts: 40 },
    });
    assert.ok(deep.verified.median > shallow.verified.median * 3);
    assert.ok(shallow.verified.median < 0.5, 'a one-turn question earns very little');
  });

  test('every category prior is documented and plausible', () => {
    for (const p of Object.values(CATEGORY_PRIORS)) {
      assert.ok(p.medianHours > 0 && p.medianHours < 12, `${p.category} median out of range`);
      assert.ok(p.sigma >= 0.45 && p.sigma <= 1.0, `${p.category} sigma out of range`);
      assert.ok(p.rationale.length > 30, `${p.category} needs a rationale`);
      assert.ok(p.anchor.length > 0);
    }
  });
});

/* ================================================================== */
/* Repository resolution                                               */
/* ================================================================== */

describe('repository resolution', () => {
  test('walks up to the repository root', () => {
    const dir = tmpDir();
    try {
      clearRepoCache();
      fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src', 'deep'), { recursive: true });
      const r = resolveRepo(path.join(dir, 'src', 'deep'));
      assert.equal(r?.isGit, true);
      assert.equal(fs.realpathSync(r?.root as string), fs.realpathSync(dir));
    } finally {
      cleanup(dir);
    }
  });

  test('a linked worktree resolves to its main checkout', () => {
    const root = tmpDir();
    try {
      clearRepoCache();
      const main = path.join(root, 'main');
      const wt = path.join(root, 'wt');
      fs.mkdirSync(path.join(main, '.git', 'worktrees', 'wt'), { recursive: true });
      fs.mkdirSync(wt, { recursive: true });
      fs.writeFileSync(
        path.join(wt, '.git'),
        `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`,
      );
      const r = resolveRepo(wt);
      assert.ok(r);
      assert.equal(
        fs.realpathSync(r?.root as string),
        fs.realpathSync(main),
        'worktree work belongs to the same project',
      );
      assert.ok(r?.worktreeOf);
    } finally {
      cleanup(root);
    }
  });

  test('nested repositories resolve to the innermost one', () => {
    const root = tmpDir();
    try {
      clearRepoCache();
      fs.mkdirSync(path.join(root, '.git'), { recursive: true });
      const inner = path.join(root, 'packages', 'inner');
      fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
      const r = resolveRepo(inner);
      assert.equal(fs.realpathSync(r?.root as string), fs.realpathSync(inner));
    } finally {
      cleanup(root);
    }
  });

  test('a non-git directory is still a project, marked as such', () => {
    const dir = tmpDir();
    try {
      clearRepoCache();
      const r = resolveRepo(dir);
      assert.equal(r?.isGit, false);
      assert.ok(r?.repoId);
    } finally {
      cleanup(dir);
    }
  });

  test('paths outside the allowed roots are not inspected', () => {
    clearRepoCache();
    assert.equal(resolveRepo('/etc', { allowedRoots: ['/tmp/allowed'] }), null);
  });

  test('the same identity is produced for the same root', () => {
    const dir = tmpDir();
    try {
      clearRepoCache();
      const a = resolveRepo(dir);
      clearRepoCache();
      const b = resolveRepo(dir);
      assert.equal(a?.repoId, b?.repoId);
    } finally {
      cleanup(dir);
    }
  });
});

/* ================================================================== */
/* Day bucketing                                                       */
/* ================================================================== */

describe('day bucketing', () => {
  test('a session crossing midnight lands in two day keys', () => {
    const before = new Date(2026, 4, 12, 23, 50).getTime();
    const after = new Date(2026, 4, 13, 0, 20).getTime();
    assert.notEqual(dayKey(before), dayKey(after));
    assert.equal(dayKey(before), '2026-05-12');
    assert.equal(dayKey(after), '2026-05-13');
  });

  test('an explicit timezone is honoured', () => {
    const t = Date.UTC(2026, 4, 12, 2, 0, 0);
    assert.equal(dayKey(t, 'UTC'), '2026-05-12');
    assert.equal(dayKey(t, 'America/Los_Angeles'), '2026-05-11');
  });
});

describe('provider-side errors', () => {
  test('a rate-limit error is not counted as debugging difficulty', () => {
    const withRateLimit = [
      ev('user.instruction', T0, { text: 'implement the exporter' }),
      ev('file.modified', T0 + MIN, {
        files: [fileChange('/r/src/a.ts', 'update', 30, 4)],
        paths: ['/r/src/a.ts'],
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        ev('error.encountered', T0 + (2 + i) * MIN, {
          text: "You've hit your usage limit.",
          reason: 'usage_limit_exceeded',
        }),
      ),
    ];
    const seg = reconstructTasks(withRateLimit)[0];
    assert.ok(seg);
    assert.equal(
      extractEvidence(seg as never, '/r').errorsEncountered,
      0,
      'provider failures are friction, not task difficulty',
    );
  });

  test('genuine errors are still counted', () => {
    const events = [
      ev('user.instruction', T0, { text: 'fix the crash' }),
      ev('file.modified', T0 + MIN, {
        files: [fileChange('/r/src/a.ts', 'update', 5, 5)],
        paths: ['/r/src/a.ts'],
      }),
      ev('error.encountered', T0 + 2 * MIN, { text: 'AssertionError: expected 1, got 2' }),
      ev('error.encountered', T0 + 3 * MIN, { text: 'TypeError: undefined is not a function' }),
    ];
    const seg = reconstructTasks(events)[0];
    assert.equal(extractEvidence(seg as never, '/r').errorsEncountered, 2);
  });
});

describe('LLM hours and prompting hours', () => {
  test('LLM hours sum across concurrent workers and can exceed the day', () => {
    // Fifteen agents, each busy for a full hour at the same time.
    const events = Array.from({ length: 15 }, (_, i) =>
      ev('turn.completed', T0 + 60 * MIN, { durationMs: 3600_000 }, { sessionId: `s${i}` }),
    );
    const c = computeConcurrency(computeAgentIntervals(events));
    assert.equal(c.totalAgentMs, 15 * 3600_000, '15 LLM hours from one elapsed hour');
    assert.equal(c.wallClockAgentMs, 3600_000, 'elapsed time is still one hour');
    assert.equal(c.peak, 15);
  });

  test('prompting hours are a strict subset of steering hours', () => {
    const events = [
      ev('user.instruction', T0, { text: 'build the thing' }),
      ev('turn.completed', T0 + 10 * MIN, { durationMs: 600_000 }),
      ev('user.instruction', T0 + 20 * MIN, { text: 'now add tests' }),
      ev('turn.completed', T0 + 30 * MIN, { durationMs: 600_000 }),
    ];
    const r = computeSteering(events, STEERING_BALANCED);
    assert.ok(r.promptingMs > 0, 'writing instructions is counted');
    assert.ok(r.promptingMs < r.totalMs, 'but it excludes reading and reviewing');
  });

  test('reading agent output counts as steering but not as prompting', () => {
    const onlyReading = [
      ev('turn.completed', T0, { durationMs: 60_000 }),
      ev('assistant.message', T0 + MIN, { text: 'done' }),
    ];
    const r = computeSteering(onlyReading, STEERING_BALANCED);
    assert.ok(r.totalMs > 0, 'someone read the output');
    assert.equal(r.promptingMs, 0, 'but nobody typed anything');
  });

  test('an interrupt is steering, not prompting', () => {
    const r = computeSteering(
      [ev('user.interrupt', T0, { reason: 'interrupted' })],
      STEERING_BALANCED,
    );
    assert.ok(r.totalMs > 0);
    assert.equal(r.promptingMs, 0);
  });

  test('concurrent prompting is still unioned, never multiplied', () => {
    const one = [ev('user.instruction', T0, { text: 'go' }, { sessionId: 'a' })];
    const four = ['a', 'b', 'c', 'd'].map((s) =>
      ev('user.instruction', T0, { text: 'go' }, { sessionId: s }),
    );
    assert.equal(
      computeSteering(four, STEERING_BALANCED).promptingMs,
      computeSteering(one, STEERING_BALANCED).promptingMs,
    );
  });
});
