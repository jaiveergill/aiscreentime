import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Db } from '../../src/store/db.ts';
import { ingest } from '../../src/ingest/engine.ts';
import { ClaudeCodeCollector } from '../../src/collectors/claude/index.ts';
import { CodexCollector } from '../../src/collectors/codex/index.ts';
import { computeDerived } from '../../src/analytics/pipeline.ts';
import { computeDayMetrics } from '../../src/analytics/metrics.ts';
import { clearRepoCache } from '../../src/repo/resolve.ts';
import { cleanup, settings, tmpDir } from '../helpers.ts';

/**
 * Stress fixtures are *generated*, never committed. A few hundred megabytes of
 * synthetic transcripts in the repository would be worse than useless.
 */

const SESSIONS = Number(process.env['SCREENTIME_STRESS_SESSIONS'] ?? 400);
const RECORDS_PER_SESSION = Number(process.env['SCREENTIME_STRESS_RECORDS'] ?? 60);

function generateClaudeCorpus(home: string, sessions: number, records: number): number {
  let bytes = 0;
  const projects = 12;
  for (let s = 0; s < sessions; s++) {
    const cwd = `/tmp/stress-repo-${s % projects}`;
    const dir = path.join(home, 'projects', cwd.replace(/\//g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const sid = `${String(s).padStart(8, '0')}-2222-3333-4444-555555555555`;
    const base = Date.UTC(2026, 4, 1 + (s % 20), 9, 0, 0);
    const lines: string[] = [];
    for (let i = 0; i < records; i++) {
      const ts = new Date(base + i * 45_000).toISOString();
      const common = {
        sessionId: sid,
        cwd,
        version: '2.1.220',
        gitBranch: 'main',
        isSidechain: false,
        timestamp: ts,
      };
      if (i % 10 === 0) {
        lines.push(
          JSON.stringify({
            ...common,
            type: 'user',
            uuid: `u${s}-${i}`,
            message: { role: 'user', content: `Implement feature ${i} in module ${i % 7}` },
          }),
        );
      } else if (i % 10 === 3) {
        lines.push(
          JSON.stringify({
            ...common,
            type: 'user',
            uuid: `e${s}-${i}`,
            message: {
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }],
            },
            toolUseResult: {
              type: 'update',
              filePath: `${cwd}/src/mod${i % 7}.ts`,
              structuredPatch: [{ lines: ['+a', '+b', '-c'] }],
              originalFile: 'x',
              userModified: false,
            },
          }),
        );
      } else if (i % 10 === 6) {
        lines.push(
          JSON.stringify({
            ...common,
            type: 'assistant',
            uuid: `a${s}-${i}`,
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [
                { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'npm test' } },
              ],
              usage: {
                input_tokens: 100,
                output_tokens: 50,
                cache_read_input_tokens: 0,
                cache_creation_input_tokens: 0,
              },
            },
          }),
        );
      } else {
        // A long assistant message: transcripts are dominated by these.
        lines.push(
          JSON.stringify({
            ...common,
            type: 'assistant',
            uuid: `m${s}-${i}`,
            message: {
              role: 'assistant',
              model: 'claude-opus-5',
              content: [{ type: 'text', text: `Working on it. ${'context '.repeat(120)}` }],
              usage: {
                input_tokens: 900,
                output_tokens: 400,
                cache_read_input_tokens: 100,
                cache_creation_input_tokens: 0,
              },
            },
          }),
        );
      }
    }
    const body = `${lines.join('\n')}\n`;
    bytes += Buffer.byteLength(body);
    fs.writeFileSync(path.join(dir, `${sid}.jsonl`), body);
  }
  return bytes;
}

describe('performance', () => {
  test(
    `ingests ${SESSIONS} sessions incrementally and stays responsive`,
    { timeout: 240_000 },
    async () => {
      const dbDir = tmpDir('perf-db-');
      const home = tmpDir('perf-home-');
      const codex = tmpDir('perf-codex-');
      try {
        clearRepoCache();
        const bytes = generateClaudeCorpus(home, SESSIONS, RECORDS_PER_SESSION);
        const mb = bytes / 1e6;
        assert.ok(mb > 5, `the corpus should be substantial, got ${mb.toFixed(1)} MB`);

        const db = new Db({ dir: dbDir });
        const opts = {
          collectors: [new ClaudeCodeCollector(home), new CodexCollector(codex)],
          settings: settings(),
        };

        const t0 = Date.now();
        const first = await ingest(db, opts);
        const firstMs = Date.now() - t0;

        assert.equal(first.filesParsed, SESSIONS);
        assert.ok(first.eventsIngested > SESSIONS * 10);

        // Throughput floor, deliberately loose so the test is not flaky on slow
        // machines but still catches an order-of-magnitude regression.
        const mbPerSec = mb / (firstMs / 1000);
        assert.ok(mbPerSec > 3, `ingest throughput ${mbPerSec.toFixed(1)} MB/s is too slow`);

        // The second pass must read nothing at all.
        const t1 = Date.now();
        const second = await ingest(db, opts);
        const secondMs = Date.now() - t1;
        assert.equal(second.filesParsed, 0);
        assert.equal(second.bytesRead, 0);
        assert.ok(
          secondMs < firstMs / 3,
          `re-scan (${secondMs}ms) must be far cheaper than the first (${firstMs}ms)`,
        );

        const t2 = Date.now();
        const derived = computeDerived(db, { settings: settings() });
        const deriveMs = Date.now() - t2;
        assert.ok(derived.tasksBuilt > 0);
        assert.ok(deriveMs < 120_000, `derivation took ${deriveMs}ms`);

        // Memory must stay bounded: we stream, we never load the corpus.
        const heapMb = process.memoryUsage().heapUsed / 1e6;
        assert.ok(heapMb < 900, `heap grew to ${heapMb.toFixed(0)} MB`);

        db.close();
      } finally {
        cleanup(dbDir, home, codex);
      }
    },
  );

  test('a day query stays fast with many tasks', { timeout: 120_000 }, async () => {
    const dbDir = tmpDir('perf-q-');
    const home = tmpDir('perf-qh-');
    const codex = tmpDir('perf-qc-');
    try {
      clearRepoCache();
      generateClaudeCorpus(home, 60, 40);
      const db = new Db({ dir: dbDir });
      const s = settings();
      await ingest(db, {
        collectors: [new ClaudeCodeCollector(home), new CodexCollector(codex)],
        settings: s,
      });
      computeDerived(db, { settings: s });

      const t0 = Date.now();
      const m = computeDayMetrics(db, '2026-05-01', s);
      const ms = Date.now() - t0;
      assert.ok(ms < 5000, `day metrics took ${ms}ms`);
      assert.ok(m.taskCount >= 0);
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });

  test(
    'a transcript with very long tool outputs does not exhaust memory',
    { timeout: 120_000 },
    async () => {
      const dbDir = tmpDir('perf-big-');
      const home = tmpDir('perf-bigh-');
      const codex = tmpDir('perf-bigc-');
      try {
        clearRepoCache();
        const dir = path.join(home, 'projects', '-tmp-big');
        fs.mkdirSync(dir, { recursive: true });
        const huge = 'x'.repeat(4 * 1024 * 1024);
        const lines: string[] = [];
        for (let i = 0; i < 12; i++) {
          lines.push(
            JSON.stringify({
              sessionId: 'big-session',
              cwd: '/tmp/big',
              version: '2.1.220',
              type: 'user',
              uuid: `u${i}`,
              timestamp: new Date(Date.UTC(2026, 4, 12, 9, i)).toISOString(),
              message: {
                role: 'user',
                content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok' }],
              },
              toolUseResult: { stdout: huge, stderr: '', interrupted: false, isImage: false },
            }),
          );
        }
        fs.writeFileSync(path.join(dir, 'big-session.jsonl'), `${lines.join('\n')}\n`);

        const before = process.memoryUsage().heapUsed;
        const db = new Db({ dir: dbDir });
        const r = await ingest(db, {
          collectors: [new ClaudeCodeCollector(home), new CodexCollector(codex)],
          settings: settings(),
        });
        const growthMb = (process.memoryUsage().heapUsed - before) / 1e6;

        assert.ok(r.eventsIngested > 0);
        assert.ok(growthMb < 400, `heap grew ${growthMb.toFixed(0)} MB parsing a 48 MB transcript`);

        // Stored text must be capped, not the full 4 MB output.
        const row = db.handle
          .prepare("SELECT payload FROM events WHERE kind = 'tool.result' LIMIT 1")
          .get() as { payload: string } | undefined;
        assert.ok(row);
        assert.ok(
          row.payload.length < 8000,
          `stored payload is ${row.payload.length} bytes; text must be capped`,
        );
        db.close();
      } finally {
        cleanup(dbDir, home, codex);
      }
    },
  );

  test('a corpus of malformed files degrades gracefully', { timeout: 60_000 }, async () => {
    const dbDir = tmpDir('perf-mal-');
    const home = tmpDir('perf-malh-');
    const codex = tmpDir('perf-malc-');
    try {
      clearRepoCache();
      const dir = path.join(home, 'projects', '-tmp-mal');
      fs.mkdirSync(dir, { recursive: true });
      for (let f = 0; f < 20; f++) {
        const lines: string[] = [];
        for (let i = 0; i < 50; i++) {
          if (i % 3 === 0) lines.push('{ broken json ');
          else if (i % 5 === 0) lines.push('');
          else if (i % 7 === 0) lines.push('12345');
          else {
            lines.push(
              JSON.stringify({
                sessionId: `mal-${f}`,
                cwd: '/tmp/mal',
                version: '2.1.220',
                type: 'user',
                uuid: `u${f}-${i}`,
                timestamp: new Date(Date.UTC(2026, 4, 12, 9, i)).toISOString(),
                message: { role: 'user', content: `valid record ${i}` },
              }),
            );
          }
        }
        fs.writeFileSync(path.join(dir, `mal-${f}.jsonl`), `${lines.join('\n')}\n`);
      }

      const db = new Db({ dir: dbDir });
      const r = await ingest(db, {
        collectors: [new ClaudeCodeCollector(home), new CodexCollector(codex)],
        settings: settings(),
      });
      assert.equal(r.filesParsed, 20, 'every file is still processed');
      assert.ok(r.eventsIngested > 0, 'valid records survive');
      const health = Object.values(r.health)[0];
      assert.ok((health?.recordsMalformed ?? 0) > 100, 'and the damage is counted, not hidden');
      db.close();
    } finally {
      cleanup(dbDir, home, codex);
    }
  });
});
