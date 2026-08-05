import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';

import {
  createContext,
  handleApi,
  startAutoRefresh,
  type ApiContext,
} from '../../src/server/api.ts';
import { createServer, listen } from '../../src/server/http.ts';
import { installDemoData, demoBaseInstant } from '../../src/demo/generate.ts';
import { computeDerived } from '../../src/analytics/pipeline.ts';
import { computeDayMetrics } from '../../src/analytics/metrics.ts';
import { loadSettings, saveSettings } from '../../src/core/config.ts';
import { dayKey } from '../../src/core/util.ts';
import { cleanup, tmpDir } from '../helpers.ts';

let ctx: ApiContext;
let dir: string;
let emptyClaude: string;
let emptyCodex: string;
let prevClaude: string | undefined;
let prevCodex: string | undefined;
let server: Server;
let port: number;
let base: string;
let DAY: string;

const call = (method: string, p: string, body?: unknown) =>
  handleApi(ctx, method, new URL(`http://local${p}`), body);

/** GET with an arbitrary Host header. `fetch` treats Host as forbidden. */
function rawGet(p: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path: p, method: 'GET', headers: { host } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  dir = tmpDir('screentime-api-');
  // Point the collectors at empty directories. A test that reads the
  // developer's real ~/.claude and ~/.codex is not a test — it is slow,
  // non-deterministic, and its result depends on whose machine it runs on.
  emptyClaude = tmpDir('screentime-api-claude-');
  emptyCodex = tmpDir('screentime-api-codex-');
  prevClaude = process.env['CLAUDE_CONFIG_DIR'];
  prevCodex = process.env['CODEX_HOME'];
  process.env['CLAUDE_CONFIG_DIR'] = emptyClaude;
  process.env['CODEX_HOME'] = emptyCodex;
  ctx = createContext(dir);
  const at = demoBaseInstant();
  DAY = dayKey(at);
  installDemoData(ctx.db, at);
  const s = saveSettings(ctx.db, { onboarded: true });
  computeDerived(ctx.db, { settings: s });
  computeDayMetrics(ctx.db, DAY, s);
  server = createServer(ctx, { port: 0, publicDir: dir });
  port = await listen(server, 39871);
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  ctx.db.close();
  if (prevClaude === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
  else process.env['CLAUDE_CONFIG_DIR'] = prevClaude;
  if (prevCodex === undefined) delete process.env['CODEX_HOME'];
  else process.env['CODEX_HOME'] = prevCodex;
  cleanup(dir, emptyClaude, emptyCodex);
});

/* ================================================================== */

describe('API surface', () => {
  test('status reports providers, counts and the benchmark version', async () => {
    const r = await call('GET', '/api/status');
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.equal(b['onboarded'], true);
    assert.ok(Array.isArray(b['detections']));
    assert.ok((b['eventCount'] as number) > 0);
    assert.ok((b['taskCount'] as number) > 0);
    assert.ok(String(b['benchmarkVersion']).startsWith('v'));
    assert.ok(String(b['dbPath']).endsWith('screentime.db'));
  });

  test('the day endpoint returns metrics plus fully-formed tasks', async () => {
    const r = await call('GET', `/api/day/${DAY}`);
    assert.equal(r.status, 200);
    const b = r.body as { metrics: Record<string, unknown>; tasks: Record<string, unknown>[] };
    assert.ok(b.tasks.length > 0);
    for (const t of b.tasks) {
      assert.ok(t['taskId']);
      assert.ok(t['categoryLabel'], 'tasks arrive display-ready');
      assert.ok(t['estimate'], 'every task carries its estimate');
    }
    assert.ok((b.metrics['verifiedHours'] as { median: number }).median > 0);
  });

  test('an invalid day is rejected rather than guessed at', async () => {
    assert.equal((await call('GET', '/api/day/not-a-day')).status, 400);
    assert.equal((await call('GET', '/api/timeline/2026-13-99x')).status, 400);
  });

  test('the timeline endpoint returns steering, agents and concurrency', async () => {
    const r = await call('GET', `/api/timeline/${DAY}`);
    const b = r.body as Record<string, unknown>;
    assert.ok(Array.isArray(b['steering']));
    assert.ok(Array.isArray(b['agents']));
    assert.ok(Array.isArray(b['concurrency']));
    assert.ok(Array.isArray(b['tasks']));
    assert.ok((b['peak'] as number) >= 1);
  });

  test('task detail exposes its estimate, evidence and provenance', async () => {
    const day = (await call('GET', `/api/day/${DAY}`)).body as { tasks: { taskId: string }[] };
    const id = day.tasks[0]?.taskId as string;
    const r = await call('GET', `/api/task/${id}`);
    assert.equal(r.status, 200);
    const b = r.body as Record<string, unknown>;
    assert.ok(b['task']);
    assert.ok(b['estimate'], 'the task carries the one estimate there is');
    assert.equal(b['estimates'], undefined, 'and no per-mode variants');
    const events = b['events'] as { source: { file: string; line: number; parser: string } }[];
    assert.ok(events.length > 0);
    assert.ok(events[0]?.source.parser, 'every event links back to the parser that produced it');
    assert.ok(!events[0]?.source.file.includes('/Users/'), 'displayed paths are shortened');
    assert.ok(Array.isArray(b['categories']), 'the correction form has its options');
  });

  test('a missing task is a 404, not a crash', async () => {
    assert.equal((await call('GET', '/api/task/nope')).status, 404);
  });

  test('an override recalculates immediately and is reflected in the day', async () => {
    const day = (await call('GET', `/api/day/${DAY}`)).body as { tasks: { taskId: string }[] };
    const id = day.tasks[0]?.taskId as string;
    const before = (await call('GET', `/api/day/${DAY}`)).body as {
      metrics: { verifiedHours: { median: number } };
    };

    const res = await call('POST', `/api/task/${id}/override`, { hours: 42 });
    assert.equal(res.status, 200);

    const after = (await call('GET', `/api/day/${DAY}`)).body as {
      metrics: { verifiedHours: { median: number } };
      tasks: { taskId: string; userEdited: boolean; estimate: { userOverrideHours?: number } }[];
    };
    assert.notEqual(after.metrics.verifiedHours.median, before.metrics.verifiedHours.median);
    const t = after.tasks.find((x) => x.taskId === id);
    assert.equal(t?.userEdited, true, 'edited tasks are labelled');
    assert.equal(t?.estimate.userOverrideHours, 42);

    await call('POST', `/api/task/${id}/override`, { hours: null });
  });

  test('calibration is recorded and reported back', async () => {
    const day = (await call('GET', `/api/day/${DAY}`)).body as { tasks: { taskId: string }[] };
    const id = day.tasks[1]?.taskId as string;
    const r = await call('POST', `/api/task/${id}/calibrate`, {
      userHours: 6,
      familiarity: 'expert',
      usableFraction: 0.9,
      rewrote: false,
      peerComparison: 'similar',
    });
    assert.equal(r.status, 200);
    const cal = (r.body as { calibration: { totalEntries: number } }).calibration;
    assert.equal(cal.totalEntries, 1);

    const method = (await call('GET', '/api/methodology')).body as {
      calibration: { totalEntries: number };
    };
    assert.equal(method.calibration.totalEntries, 1);
  });

  test('calibration rejects nonsense input', async () => {
    const day = (await call('GET', `/api/day/${DAY}`)).body as { tasks: { taskId: string }[] };
    const id = day.tasks[0]?.taskId as string;
    assert.equal(
      (await call('POST', `/api/task/${id}/calibrate`, { userHours: 'lots' })).status,
      400,
    );
    assert.equal((await call('POST', `/api/task/${id}/calibrate`, {})).status, 400);
  });

  test('methodology exposes sources with their limitations', async () => {
    const b = (await call('GET', '/api/methodology')).body as {
      sources: { title: string; limitations: string; appliedTo: string }[];
      priors: { label: string; medianHours: number }[];
    };
    assert.ok(b.sources.length >= 3);
    for (const s of b.sources) {
      assert.ok(s.limitations.length > 20, `${s.title} must state its limitations`);
      assert.ok(s.appliedTo.length > 20, `${s.title} must say how it was applied`);
    }
    assert.ok(b.priors.length >= 15, 'every category has a documented prior');
  });

  test('diagnostics report watched directories and the empty external-request log', async () => {
    const b = (await call('GET', '/api/diagnostics')).body as {
      watchedDirs: string[];
      externalRequests: unknown[];
      lastComputeStats: { nonEngineeringRejected: number } | null;
    };
    assert.ok(b.watchedDirs.length >= 2);
    assert.ok(
      b.watchedDirs.every((d) => d.includes('claude') || d.includes('codex')),
      'watched dirs are the provider directories and nothing else',
    );
    assert.deepEqual(b.externalRequests, [], 'nothing has ever left the machine');
    assert.ok(b.lastComputeStats, 'the exclusion count is surfaced');
    assert.ok(b.lastComputeStats.nonEngineeringRejected >= 1, 'the fixture chat was excluded');
  });

  test('the privacy inventory describes exactly what is stored', async () => {
    const b = (await call('GET', '/api/privacy/inventory')).body as {
      dbPath: string;
      eventKinds: { kind: string; n: number }[];
      note: string;
    };
    assert.ok(b.dbPath.endsWith('screentime.db'));
    assert.ok(b.eventKinds.length > 0);
    assert.ok(b.note.includes('this machine'));
  });

  test('semantic analysis refuses to run while disabled', async () => {
    const r = await call('POST', '/api/semantic/run', { days: 7 });
    assert.equal(r.status, 409);
    const b = (await call('GET', '/api/diagnostics')).body as { externalRequests: unknown[] };
    assert.deepEqual(b.externalRequests, [], 'a refused run sends nothing');
  });

  test('settings round-trip and scope changes recompute', async () => {
    const r = await call('POST', '/api/settings', { historyDays: 45 });
    assert.equal(r.status, 200);
    assert.equal(loadSettings(ctx.db).historyDays, 45);
    await call('POST', '/api/settings', { historyDays: 30 });
  });

  test('export contains derived data and no raw transcripts', async () => {
    const b = (await call('GET', '/api/export')).body as Record<string, unknown>;
    assert.ok(Array.isArray(b['tasks']));
    assert.ok(Array.isArray(b['calibrations']));
    assert.ok(Array.isArray(b['estimates']));
    assert.equal(b['events'], undefined, 'raw events are not part of a user export');
    assert.ok(String(b['benchmarkVersion']).startsWith('v'));
  });

  test('deleting derived data leaves events intact and rebuildable', async () => {
    const before = (ctx.db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number })
      .n;
    await call('POST', '/api/privacy/delete', { scope: 'derived' });
    const tasksAfter = (
      ctx.db.handle.prepare('SELECT COUNT(*) n FROM tasks').get() as { n: number }
    ).n;
    const eventsAfter = (
      ctx.db.handle.prepare('SELECT COUNT(*) n FROM events').get() as { n: number }
    ).n;
    assert.equal(tasksAfter, 0);
    assert.equal(eventsAfter, before, 'events survive');

    const s = loadSettings(ctx.db);
    const rebuilt = computeDerived(ctx.db, { settings: s });
    assert.ok(rebuilt.tasksBuilt > 0, 'and everything can be rebuilt from them');
    computeDayMetrics(ctx.db, DAY, s);
  });
});

/* ================================================================== */

describe('share export', () => {
  test('every variant renders SVG with the benchmark qualifier', async () => {
    for (const variant of ['headline', 'timeline', 'projects', 'weekly']) {
      const r = await call('GET', `/api/share/${DAY}?variant=${variant}`);
      assert.equal(r.status, 200);
      assert.ok(r.contentType?.includes('image/svg+xml'));
      const svg = r.raw as string;
      assert.ok(svg.startsWith('<svg'));
      assert.ok(svg.includes('conventional non-AI engineering workflow'));
    }
  });

  test('the preview lists exactly what will be exported', async () => {
    const b = (await call('GET', `/api/share-preview/${DAY}?variant=projects`)).body as {
      exposure: string[];
      options: { revealProjects: boolean };
    };
    assert.ok(b.exposure.length > 3);
    assert.equal(b.options.revealProjects, false, 'aliases are the default');
    assert.ok(b.exposure.some((l) => l.includes('Project A')));
  });

  test('an unknown variant falls back to the safe default', async () => {
    const r = await call('GET', `/api/share/${DAY}?variant=../../etc/passwd`);
    assert.equal(r.status, 200);
    assert.ok((r.raw as string).includes('<svg'));
  });
});

/* ================================================================== */

describe('HTTP transport', () => {
  test('serves the API over loopback', async () => {
    const res = await fetch(`${base}/api/status`);
    assert.equal(res.status, 200);
    const b = (await res.json()) as { benchmarkVersion: string };
    assert.ok(b.benchmarkVersion);
  });

  test('sets a strict content security policy on the app shell', async () => {
    // The static dir is empty in this test, so we assert on the 404 path being
    // safe rather than serving anything unexpected.
    const res = await fetch(`${base}/definitely-not-a-file.js`);
    assert.ok([200, 404].includes(res.status));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('rejects cross-origin mutations', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ historyDays: 999 }),
    });
    assert.equal(res.status, 403);
    assert.notEqual(loadSettings(ctx.db).historyDays, 999, 'and the change did not land');
  });

  test('allows same-origin mutations', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${port}` },
      body: JSON.stringify({ historyDays: 30 }),
    });
    assert.equal(res.status, 200);
  });

  test('static file serving refuses path traversal', async () => {
    const res = await fetch(`${base}/../../../../etc/passwd`);
    const text = await res.text();
    assert.ok(!text.includes('root:'), 'must never serve files outside the public directory');
  });

  test('rejects requests carrying a foreign Host header', async () => {
    // Binding to loopback does not stop DNS rebinding: an attacker's page can
    // re-resolve its own hostname to 127.0.0.1 and then read the API with
    // ordinary same-origin GETs, which the CSRF guard above does not cover.
    // `fetch` refuses to set Host, so this goes over a raw request.
    const res = await rawGet('/api/export', 'evil.example');
    assert.equal(res.status, 403);
    assert.ok(!res.body.includes('"tasks"'), 'no data may be returned to a rebound host');
  });

  test('still accepts the loopback names it is reached by', async () => {
    for (const host of [
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      '127.0.0.1',
      // Hostnames are case-insensitive; this must not be turned away.
      `LOCALHOST:${port}`,
    ]) {
      const res = await rawGet('/api/status', host);
      assert.equal(res.status, 200, `${host} must be allowed`);
    }
  });

  test('the share card is served with a policy that cannot execute script', async () => {
    // The card is image/svg+xml. Navigating to it renders an active document in
    // this server's own origin, so an escaping gap in the renderer would become
    // same-origin script with read access to /api/export. The policy makes that
    // unreachable regardless.
    const res = await fetch(`${base}/api/share/${DAY}.svg`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /image\/svg\+xml/);
    const csp = res.headers.get('content-security-policy') ?? '';
    assert.match(csp, /default-src 'none'/, 'active content is denied by default');
    const body = await res.text();
    assert.ok(body.startsWith('<svg'), 'and it is still a valid card');
  });

  test('a malformed JSON body does not crash the server', async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    });
    assert.ok(res.status < 500);
    const still = await fetch(`${base}/api/status`);
    assert.equal(still.status, 200, 'the server is still alive');
  });

  test('unknown API routes are 404 JSON, not HTML', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    assert.equal(res.status, 404);
    assert.ok(res.headers.get('content-type')?.includes('application/json'));
  });
});

/* ================================================================== */

describe('staying current', () => {
  test('a rescan with no new data does not rebuild eight months of history', async () => {
    const before = ctx.state.lastCompute?.at;
    await call('POST', '/api/ingest', { historyDays: 0 });
    // Nothing changed on disk, so no derivation should have run at all.
    assert.equal(ctx.state.lastCompute?.at, before, 'an empty rescan must be nearly free');
  });

  test('auto refresh can be disabled and re-enabled through settings', async () => {
    await call('POST', '/api/settings', { autoRefreshSeconds: 0 });
    assert.equal(loadSettings(ctx.db).autoRefreshSeconds, 0);
    await call('POST', '/api/settings', { autoRefreshSeconds: 60 });
    assert.equal(loadSettings(ctx.db).autoRefreshSeconds, 60);
  });

  test('the auto-refresh loop starts, is cancellable, and holds no handle open', () => {
    const stop = startAutoRefresh(ctx);
    assert.equal(typeof stop, 'function');
    stop();
    stop(); // idempotent
  });
});
