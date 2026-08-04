import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Db } from '../../src/store/db.ts';
import { SCHEMA_VERSION } from '../../src/store/migrations.ts';
import { ingest } from '../../src/ingest/engine.ts';
import { ClaudeCodeCollector } from '../../src/collectors/claude/index.ts';
import { CodexCollector } from '../../src/collectors/codex/index.ts';
import { computeDerived } from '../../src/analytics/pipeline.ts';
import {
  computeDayMetrics,
  activeDays,
  loadDayMetrics,
  loadTasksForDay,
  loadEstimates,
  METRICS_SHAPE_VERSION,
} from '../../src/analytics/metrics.ts';
import { BENCHMARK_VERSION } from '../../src/estimate/priors.ts';
import {
  calibrationFor,
  recordCalibration,
  calibrationSummary,
} from '../../src/calibration/model.ts';
import { loadSettings, saveSettings } from '../../src/core/config.ts';
import { clearRepoCache } from '../../src/repo/resolve.ts';
import {
  appendClaudeTranscript,
  cc,
  cleanup,
  cx,
  settings,
  tmpDir,
  writeClaudeTranscript,
  writeCodexRollout,
} from '../helpers.ts';

function collectors(claudeHome: string, codexHome: string) {
  return [new ClaudeCodeCollector(claudeHome), new CodexCollector(codexHome)];
}

/* ================================================================== */
/* Storage & migrations                                                */
/* ================================================================== */

describe('storage', () => {
  test('migrations apply once and are idempotent across reopens', () => {
    const dir = tmpDir();
    try {
      const db1 = new Db({ dir });
      const v1 = db1.handle.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as {
        n: number;
      };
      assert.equal(v1.n, SCHEMA_VERSION);
      db1.close();

      const db2 = new Db({ dir });
      const v2 = db2.handle.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as {
        n: number;
      };
      assert.equal(v2.n, SCHEMA_VERSION, 'reopening must not re-apply migrations');
      db2.close();
    } finally {
      cleanup(dir);
    }
  });

  test('settings round-trip and merge with defaults', () => {
    const dir = tmpDir();
    try {
      const db = new Db({ dir });
      assert.equal(loadSettings(db).mode, 'conservative');
      saveSettings(db, { mode: 'balanced', excludedRepos: ['/x'] });
      const s = loadSettings(db);
      assert.equal(s.mode, 'balanced');
      assert.deepEqual(s.excludedRepos, ['/x']);
      assert.equal(s.redactMode, 'standard', 'unspecified keys keep their defaults');
      db.close();
    } finally {
      cleanup(dir);
    }
  });
});

/* ================================================================== */
/* Incremental ingestion                                               */
/* ================================================================== */

describe('incremental ingestion', () => {
  test('an unchanged file is skipped entirely on the second run', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      writeClaudeTranscript(home, [
        cc.user('do the thing', '2026-05-12T09:00:00Z', 'u1'),
        cc.edit('/tmp/fixture-repo/a.ts', '2026-05-12T09:01:00Z', 'u2', 10, 2),
      ]);
      const db = new Db({ dir: dbDir });
      const opts = { collectors: collectors(home, codex), settings: settings() };

      const first = await ingest(db, opts);
      assert.equal(first.filesParsed, 1);
      assert.ok(first.eventsIngested > 0);

      const second = await ingest(db, opts);
      assert.equal(second.filesParsed, 0, 'nothing changed, so nothing is read');
      assert.equal(second.filesSkipped, 1);
      assert.equal(second.eventsIngested, 0);
      assert.equal(second.bytesRead, 0, 'not a single byte is re-read');
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('appended records are ingested without duplicating existing ones', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      const file = writeClaudeTranscript(home, [cc.user('first', '2026-05-12T09:00:00Z', 'u1')]);
      const db = new Db({ dir: dbDir });
      const opts = { collectors: collectors(home, codex), settings: settings() };
      await ingest(db, opts);
      const afterFirst = (db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number })
        .n;

      appendClaudeTranscript(file, [
        cc.user('second', '2026-05-12T09:05:00Z', 'u2'),
        cc.bash('npm test', '2026-05-12T09:06:00Z', 'a1', 'tt'),
      ]);
      const second = await ingest(db, opts);
      const afterSecond = (
        db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }
      ).n;

      assert.ok(second.eventsIngested > 0);
      assert.ok(afterSecond > afterFirst);
      const instructions = db.handle
        .prepare("SELECT COUNT(*) n FROM events WHERE kind = 'user.instruction'")
        .get() as { n: number };
      assert.equal(instructions.n, 2, 'the first instruction is not duplicated');
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('a truncated file is detected and re-parsed from the start', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      const file = writeClaudeTranscript(home, [
        cc.user('first', '2026-05-12T09:00:00Z', 'u1'),
        cc.user('second', '2026-05-12T09:05:00Z', 'u2'),
        cc.user('third', '2026-05-12T09:06:00Z', 'u3'),
      ]);
      const db = new Db({ dir: dbDir });
      const opts = { collectors: collectors(home, codex), settings: settings() };
      await ingest(db, opts);

      // Rotate: replace with a shorter, different file.
      fs.writeFileSync(
        file,
        `${JSON.stringify({ type: 'user', sessionId: 'rotated', cwd: '/tmp/fixture-repo', uuid: 'r1', timestamp: '2026-05-12T10:00:00Z', message: { role: 'user', content: 'rotated content' } })}\n`,
      );

      const second = await ingest(db, opts);
      assert.ok(second.truncatedFiles.includes(file), 'truncation is detected and reported');
      assert.equal(second.filesParsed, 1);
      const row = db.handle.prepare('SELECT note FROM sources WHERE path = ?').get(file) as {
        note: string;
      };
      assert.ok(row.note?.includes('re-parsed'), 'the reason is recorded for the diagnostics view');
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('a rewritten file with the same size is detected via its head fingerprint', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      const file = writeClaudeTranscript(home, [cc.user('aaaaa', '2026-05-12T09:00:00Z', 'u1')]);
      const db = new Db({ dir: dbDir });
      const opts = { collectors: collectors(home, codex), settings: settings() };
      await ingest(db, opts);
      const size = fs.statSync(file).size;

      const rewritten = fs.readFileSync(file, 'utf8').replace('aaaaa', 'bbbbb');
      fs.writeFileSync(file, rewritten);
      fs.utimesSync(file, new Date(), new Date(Date.now() + 1000));
      assert.equal(fs.statSync(file).size, size, 'same size, different content');

      const second = await ingest(db, opts);
      assert.ok(second.truncatedFiles.includes(file));
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('a vanished file is marked missing and its events are retained', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      const file = writeClaudeTranscript(home, [cc.user('x', '2026-05-12T09:00:00Z', 'u1')]);
      const db = new Db({ dir: dbDir });
      const opts = { collectors: collectors(home, codex), settings: settings() };
      await ingest(db, opts);
      const before = (db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;

      fs.unlinkSync(file);
      await ingest(db, opts);
      const after = (db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;
      assert.equal(after, before, 'history survives the source disappearing');
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('interrupted ingestion resumes without loss or duplication', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      for (let i = 0; i < 6; i++) {
        writeClaudeTranscript(home, [cc.user(`session ${i}`, `2026-05-12T09:0${i}:00Z`, `u${i}`)], {
          sessionId: `1111111${i}-2222-3333-4444-555555555555`,
          cwd: `/tmp/repo-${i}`,
        });
      }
      const db = new Db({ dir: dbDir });
      const ac = new AbortController();
      const opts = { collectors: collectors(home, codex), settings: settings() };

      // Abort after the first file is parsed.
      let done = 0;
      const partial = await ingest(db, {
        ...opts,
        signal: ac.signal,
        onProgress: (p) => {
          if (p.stage === 'parse') {
            done++;
            if (done >= 2) ac.abort();
          }
        },
      });
      assert.ok(partial.cancelled || partial.filesParsed < 6);

      const resumed = await ingest(db, opts);
      const total = partial.filesParsed + resumed.filesParsed;
      assert.equal(total, 6, 'every file is eventually parsed exactly once');

      const instructions = db.handle
        .prepare("SELECT COUNT(*) n FROM events WHERE kind = 'user.instruction'")
        .get() as { n: number };
      assert.equal(instructions.n, 6, 'no duplicates after resuming');
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('the history window excludes older files without reading them', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      const old = writeClaudeTranscript(home, [cc.user('ancient', '2020-01-01T09:00:00Z', 'u1')], {
        sessionId: '00000000-2222-3333-4444-555555555555',
        cwd: '/tmp/old-repo',
      });
      fs.utimesSync(
        old,
        new Date(Date.now() - 400 * 24 * 3600_000),
        new Date(Date.now() - 400 * 24 * 3600_000),
      );
      writeClaudeTranscript(home, [cc.user('recent', '2026-05-12T09:00:00Z', 'u2')], {
        sessionId: '11111111-2222-3333-4444-555555555555',
        cwd: '/tmp/new-repo',
      });

      const db = new Db({ dir: dbDir });
      const r = await ingest(db, {
        collectors: collectors(home, codex),
        settings: settings({ historyDays: 30 }),
      });
      assert.equal(r.filesParsed, 1);
      assert.ok(r.filesSkipped >= 1);
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('a disabled provider is never read', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      writeClaudeTranscript(home, [cc.user('cc', '2026-05-12T09:00:00Z', 'u1')]);
      writeCodexRollout(codex, [cx.userMessage('cx', '2026-05-12T09:00:00Z')]);
      const db = new Db({ dir: dbDir });
      await ingest(db, {
        collectors: collectors(home, codex),
        settings: settings({ providers: { 'claude-code': true, codex: false } }),
      });
      const providers = db.handle.prepare('SELECT DISTINCT provider FROM events').all() as {
        provider: string;
      }[];
      assert.deepEqual(
        providers.map((p) => p.provider),
        ['claude-code'],
      );
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('an excluded session contributes no events', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      const sid = '11111111-2222-3333-4444-555555555555';
      writeClaudeTranscript(home, [cc.user('secret work', '2026-05-12T09:00:00Z', 'u1')], {
        sessionId: sid,
      });
      const db = new Db({ dir: dbDir });
      await ingest(db, {
        collectors: collectors(home, codex),
        settings: settings({ excludedSessions: [sid] }),
      });
      const n = (db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }).n;
      assert.equal(n, 0);
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('parser health is persisted and accumulates across runs', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      const file = writeClaudeTranscript(home, [cc.user('a', '2026-05-12T09:00:00Z', 'u1')]);
      const db = new Db({ dir: dbDir });
      const opts = { collectors: collectors(home, codex), settings: settings() };
      await ingest(db, opts);
      appendClaudeTranscript(file, [cc.user('b', '2026-05-12T09:05:00Z', 'u2')]);
      await ingest(db, opts);

      const row = db.handle
        .prepare('SELECT payload FROM parser_health WHERE provider = ?')
        .get('claude-code') as { payload: string } | undefined;
      assert.ok(row);
      const h = JSON.parse(row.payload) as { eventsEmitted: number; filesSeen: number };
      assert.ok(h.eventsEmitted >= 2);
      assert.equal(h.filesSeen, 2, 'health accumulates across runs');
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });
});

/* ================================================================== */
/* Full pipeline                                                       */
/* ================================================================== */

describe('ingest → derive → metrics', () => {
  test('produces tasks, estimates and day metrics from two providers', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    const repo = tmpDir();
    try {
      clearRepoCache();
      fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'src', 'auth.ts'), 'export const x = 1;\n');

      writeClaudeTranscript(
        home,
        [
          cc.user(
            'Implement password reset with email tokens and add tests',
            '2026-05-12T09:00:00Z',
            'u1',
          ),
          cc.edit(path.join(repo, 'src', 'auth.ts'), '2026-05-12T09:02:00Z', 'u2', 120, 8),
          cc.bash('npm test', '2026-05-12T09:05:00Z', 'a1', 't1'),
          cc.bashResult('12 passed', '2026-05-12T09:06:00Z', 'u3', 't1'),
          cc.turnDuration(360000, '2026-05-12T09:06:30Z', 's1'),
        ],
        { cwd: repo },
      );
      writeCodexRollout(
        codex,
        [
          cx.userMessage(
            'Refactor the parser module and simplify the switch',
            '2026-05-12T11:00:00Z',
          ),
          cx.patchApplyEnd(
            path.join(repo, 'src', 'parse.ts'),
            'update',
            '--- a\n+++ b\n+a\n+b\n+c\n-x\n-y\n',
            '2026-05-12T11:03:00Z',
            'p1',
          ),
          cx.execEnd('pytest tests/', 0, '2026-05-12T11:05:00Z', 'e1'),
          cx.taskComplete(300000, '2026-05-12T11:06:00Z', 'turn1'),
        ],
        { cwd: repo },
      );

      const db = new Db({ dir: dbDir });
      const s = settings();
      const ing = await ingest(db, { collectors: collectors(home, codex), settings: s });
      assert.ok(ing.eventsIngested > 0);

      const derived = computeDerived(db, { settings: s });
      assert.ok(derived.tasksBuilt >= 2, `expected at least 2 tasks, got ${derived.tasksBuilt}`);

      const days = activeDays(db);
      assert.ok(days.includes('2026-05-12'));

      const m = computeDayMetrics(db, '2026-05-12', 'conservative', s);
      assert.ok(m.verifiedHours.median > 0);
      assert.ok(m.verifiedHours.p10 < m.verifiedHours.median);
      assert.ok(m.verifiedHours.median < m.verifiedHours.p90);
      assert.ok(m.grossHours.median >= m.acceptedHours.median);
      assert.ok(m.acceptedHours.median >= m.verifiedHours.median);
      assert.ok(m.steeringMs > 0);
      assert.ok(m.steeringLowMs <= m.steeringMs && m.steeringMs <= m.steeringHighMs);
      assert.ok(m.outputLeverage > 0);

      const tasks = loadTasksForDay(db, '2026-05-12');
      assert.ok(tasks.length >= 2);
      const est = loadEstimates(
        db,
        tasks.map((t) => t.taskId),
        'conservative',
      );
      assert.equal(est.size, tasks.length, 'every task has an estimate');
      db.close();
    } finally {
      cleanup(dbDir, home, codex, repo);
    }
  });

  test('recomputation is deterministic', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      writeClaudeTranscript(home, [
        cc.user('Add rate limiting to the public API endpoints', '2026-05-12T09:00:00Z', 'u1'),
        cc.edit('/tmp/fixture-repo/api/rate.ts', '2026-05-12T09:02:00Z', 'u2', 90, 4),
        cc.bash('npm test', '2026-05-12T09:05:00Z', 'a1', 't1'),
        cc.bashResult('ok, 3 passed', '2026-05-12T09:06:00Z', 'u3', 't1'),
      ]);
      const db = new Db({ dir: dbDir });
      const s = settings();
      await ingest(db, { collectors: collectors(home, codex), settings: s });

      computeDerived(db, { settings: s });
      const a = computeDayMetrics(db, '2026-05-12', 'conservative', s);
      computeDerived(db, { settings: s });
      const b = computeDayMetrics(db, '2026-05-12', 'conservative', s);

      assert.equal(a.taskCount, b.taskCount);
      assert.equal(a.verifiedHours.median, b.verifiedHours.median);
      assert.equal(a.steeringMs, b.steeringMs);
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('a user override changes the credited hours and is labelled', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      writeClaudeTranscript(home, [
        cc.user('Build the billing export', '2026-05-12T09:00:00Z', 'u1'),
        cc.edit('/tmp/fixture-repo/src/billing.ts', '2026-05-12T09:02:00Z', 'u2', 60, 2),
      ]);
      const db = new Db({ dir: dbDir });
      const s = settings();
      await ingest(db, { collectors: collectors(home, codex), settings: s });
      computeDerived(db, { settings: s });

      const task = loadTasksForDay(db, '2026-05-12')[0];
      assert.ok(task);
      db.handle
        .prepare('INSERT INTO task_overrides (task_id, hours, updated_at) VALUES (?,?,?)')
        .run(task.taskId, 7.5, Date.now());
      computeDerived(db, { settings: s });

      const est = loadEstimates(db, [task.taskId], 'conservative').get(task.taskId);
      assert.equal(est?.verified.median, 7.5);
      assert.equal(est?.userOverrideHours, 7.5);
      assert.equal(est?.factors[0]?.epistemics, 'user-corrected');

      const after = loadTasksForDay(db, '2026-05-12')[0];
      assert.equal(after?.userEdited, true);
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('excluding a task removes it from day totals but keeps it visible', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    try {
      clearRepoCache();
      writeClaudeTranscript(home, [
        cc.user('Task one, build the exporter', '2026-05-12T09:00:00Z', 'u1'),
        cc.edit('/tmp/fixture-repo/src/a.ts', '2026-05-12T09:02:00Z', 'u2', 60, 2),
        cc.user(
          'Completely different: tune the image resizing pipeline',
          '2026-05-12T12:00:00Z',
          'u3',
        ),
        cc.edit('/tmp/fixture-repo/img/b.ts', '2026-05-12T12:02:00Z', 'u4', 40, 2),
      ]);
      const db = new Db({ dir: dbDir });
      const s = settings();
      await ingest(db, { collectors: collectors(home, codex), settings: s });
      computeDerived(db, { settings: s });
      const before = computeDayMetrics(db, '2026-05-12', 'conservative', s);
      assert.ok(before.taskCount >= 2);

      const first = loadTasksForDay(db, '2026-05-12')[0];
      db.handle
        .prepare('INSERT INTO task_overrides (task_id, excluded, updated_at) VALUES (?,1,?)')
        .run(first?.taskId, Date.now());
      computeDerived(db, { settings: s });
      const after = computeDayMetrics(db, '2026-05-12', 'conservative', s);

      assert.equal(after.taskCount, before.taskCount - 1);
      assert.ok(after.verifiedHours.median < before.verifiedHours.median);
      assert.equal(
        loadTasksForDay(db, '2026-05-12').length,
        before.taskCount,
        'the task still exists, just excluded',
      );
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test('a scope change invalidates and recomputes the affected numbers', async () => {
    const dbDir = tmpDir();
    const home = tmpDir();
    const codex = tmpDir();
    const repo = tmpDir();
    try {
      clearRepoCache();
      writeClaudeTranscript(
        home,
        [
          cc.user('Build the exporter', '2026-05-12T09:00:00Z', 'u1'),
          cc.edit(path.join(repo, 'a.ts'), '2026-05-12T09:02:00Z', 'u2', 60, 2),
        ],
        { cwd: repo },
      );
      const db = new Db({ dir: dbDir });
      const s = settings();
      await ingest(db, { collectors: collectors(home, codex), settings: s });
      computeDerived(db, { settings: s });
      const before = computeDayMetrics(db, '2026-05-12', 'conservative', s);
      assert.ok(before.taskCount > 0);

      const excluded = settings({ excludedRepos: [fs.realpathSync(repo)] });
      computeDerived(db, { settings: excluded });
      const after = computeDayMetrics(db, '2026-05-12', 'conservative', excluded);
      assert.equal(after.taskCount, 0, 'excluding the repository removes its work entirely');
      db.close();
    } finally {
      cleanup(dbDir, home, codex, repo);
    }
  });
});

/* ================================================================== */
/* Calibration                                                         */
/* ================================================================== */

describe('personal calibration', () => {
  test('one data point barely moves the multiplier; many move it most of the way', () => {
    const dir = tmpDir();
    try {
      const db = new Db({ dir });
      recordCalibration(db, {
        taskId: 't1',
        category: 'debugging',
        estimatedHours: 2,
        userHours: 4,
      });
      const one = calibrationFor(db, 'debugging');
      assert.ok(one);
      assert.ok(
        (one?.multiplier ?? 0) > 1 && (one?.multiplier ?? 0) < 1.5,
        `expected shrinkage, got ${one?.multiplier}`,
      );

      for (let i = 2; i <= 20; i++) {
        recordCalibration(db, {
          taskId: `t${i}`,
          category: 'debugging',
          estimatedHours: 2,
          userHours: 4,
        });
      }
      const many = calibrationFor(db, 'debugging');
      assert.ok(
        (many?.multiplier ?? 0) > 1.6,
        `expected convergence toward 2×, got ${many?.multiplier}`,
      );
      assert.ok((many?.multiplier ?? 0) <= 2.05);
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  test('the multiplier is a geometric mean, so it is symmetric in ratio space', () => {
    const dir = tmpDir();
    try {
      const db = new Db({ dir });
      // Equal and opposite ratios must cancel.
      for (let i = 0; i < 10; i++) {
        recordCalibration(db, {
          taskId: `a${i}`,
          category: 'testing',
          estimatedHours: 2,
          userHours: 4,
        });
        recordCalibration(db, {
          taskId: `b${i}`,
          category: 'testing',
          estimatedHours: 4,
          userHours: 2,
        });
      }
      const c = calibrationFor(db, 'testing');
      assert.ok(Math.abs((c?.multiplier ?? 0) - 1) < 0.05, `expected ~1, got ${c?.multiplier}`);
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  test('other categories inform a category with too little data, at reduced trust', () => {
    const dir = tmpDir();
    try {
      const db = new Db({ dir });
      for (let i = 0; i < 6; i++) {
        recordCalibration(db, {
          taskId: `t${i}`,
          category: 'debugging',
          estimatedHours: 2,
          userHours: 4,
        });
      }
      const other = calibrationFor(db, 'migration');
      assert.ok(other);
      assert.equal(
        other?.categoryMatched,
        false,
        'and the UI is told it is a cross-category fallback',
      );
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  test('the personalised view only becomes available with enough data', () => {
    const dir = tmpDir();
    try {
      const db = new Db({ dir });
      assert.equal(calibrationSummary(db).personalisedViewAvailable, false);
      for (let i = 0; i < 3; i++) {
        recordCalibration(db, {
          taskId: `t${i}`,
          category: 'debugging',
          estimatedHours: 2,
          userHours: 3,
        });
      }
      const s = calibrationSummary(db);
      assert.equal(s.personalisedViewAvailable, true);
      assert.equal(s.totalEntries, 3);
      assert.ok(s.byCategory.length === 1);
      db.close();
    } finally {
      cleanup(dir);
    }
  });

  test('no calibration data yields no adjustment at all', () => {
    const dir = tmpDir();
    try {
      const db = new Db({ dir });
      assert.equal(calibrationFor(db, 'debugging'), undefined);
      db.close();
    } finally {
      cleanup(dir);
    }
  });
});

describe('cached metric shape versioning', () => {
  test('a cached payload from an older shape is a cache miss, not a half-empty object', () => {
    const dir = tmpDir();
    try {
      const db = new Db({ dir });
      // Simulate a row written by an older build that lacked several fields.
      db.handle
        .prepare(
          'INSERT INTO day_metrics (day_key, benchmark_version, mode, payload, computed_at) VALUES (?,?,?,?,?)',
        )
        .run(
          '2026-05-12',
          BENCHMARK_VERSION,
          'conservative',
          JSON.stringify({ dayKey: '2026-05-12', steeringMs: 1000 }),
          Date.now(),
        );
      assert.equal(
        loadDayMetrics(db, '2026-05-12', 'conservative'),
        undefined,
        'an unversioned payload must not be served',
      );

      // A current-shape row round-trips.
      const s = settings();
      const fresh = computeDayMetrics(db, '2026-05-12', 'conservative', s);
      assert.equal(fresh.shapeVersion, METRICS_SHAPE_VERSION);
      const loaded = loadDayMetrics(db, '2026-05-12', 'conservative');
      assert.ok(loaded);
      assert.equal(loaded?.shapeVersion, METRICS_SHAPE_VERSION);
      assert.equal(typeof loaded?.llmMs, 'number');
      assert.equal(typeof loaded?.promptingMs, 'number');
      db.close();
    } finally {
      cleanup(dir);
    }
  });
});
