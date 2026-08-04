import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ClaudeCodeCollector } from '../../src/collectors/claude/index.ts';
import { CodexCollector, extractUserRequest } from '../../src/collectors/codex/index.ts';
import type { ParseContext } from '../../src/collectors/types.ts';
import { scanJsonl } from '../../src/collectors/jsonl.ts';
import { extractEvidence, reconstructTasks } from '../../src/tasks/reconstruct.ts';
import { verifyOutcome } from '../../src/verify/outcome.ts';
import {
  appendClaudeTranscript,
  cc,
  cleanup,
  cx,
  tmpDir,
  writeClaudeSubagent,
  writeClaudeTranscript,
  writeCodexRollout,
} from '../helpers.ts';

function ctx(over: Partial<ParseContext> = {}): ParseContext {
  return {
    fromByte: 0,
    fromLine: 0,
    seen: new Set<string>(),
    redactMode: 'standard',
    customRedactTerms: [],
    ...over,
  };
}

/* ================================================================== */
/* Claude Code discovery & parsing                                     */
/* ================================================================== */

describe('Claude Code session discovery', () => {
  test('finds transcripts under projects/ and reports detection metadata', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [cc.user('hi', '2026-05-12T09:00:00Z', 'u1')], { cwd: '/tmp/a' });
      writeClaudeTranscript(home, [cc.user('hey', '2026-05-12T10:00:00Z', 'u2')], {
        cwd: '/tmp/b',
        sessionId: '99999999-2222-3333-4444-555555555555',
      });

      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      assert.equal(files.length, 2);
      assert.ok(files.every((f) => f.path.endsWith('.jsonl')));
      assert.ok(files.every((f) => f.provider === 'claude-code'));

      const det = await c.detect();
      assert.equal(det.installed, true);
      assert.equal(det.sessionFileCount, 2);
      assert.deepEqual(det.dataDirs, [path.join(home, 'projects')]);
      assert.deepEqual(det.versionsSeen, ['2.1.220']);
    } finally {
      cleanup(home);
    }
  });

  test('reports not-installed when the directory is absent, without throwing', async () => {
    const home = tmpDir();
    try {
      const c = new ClaudeCodeCollector(path.join(home, 'nope'));
      const det = await c.detect();
      assert.equal(det.installed, false);
      assert.equal(det.sessionFileCount, 0);
      assert.ok(det.notes.length > 0, 'should explain what it looked for');
      assert.deepEqual(await c.discover(), []);
    } finally {
      cleanup(home);
    }
  });

  test('honours CLAUDE_CONFIG_DIR', async () => {
    const home = tmpDir();
    const prev = process.env['CLAUDE_CONFIG_DIR'];
    try {
      process.env['CLAUDE_CONFIG_DIR'] = home;
      writeClaudeTranscript(home, [cc.user('hi', '2026-05-12T09:00:00Z', 'u1')]);
      const c = new ClaudeCodeCollector();
      assert.equal((await c.discover()).length, 1);
    } finally {
      if (prev === undefined) delete process.env['CLAUDE_CONFIG_DIR'];
      else process.env['CLAUDE_CONFIG_DIR'] = prev;
      cleanup(home);
    }
  });
});

describe('Claude Code transcript parsing', () => {
  test('normalizes instructions, tool calls, results, and token usage', async () => {
    const home = tmpDir();
    try {
      const file = writeClaudeTranscript(home, [
        cc.user('Implement password reset', '2026-05-12T09:00:00Z', 'u1'),
        cc.assistant('On it.', '2026-05-12T09:00:05Z', 'a1'),
        cc.bash('npm test', '2026-05-12T09:00:10Z', 'a2'),
        cc.bashResult('12 passed', '2026-05-12T09:00:40Z', 'u2'),
        cc.edit('/tmp/fixture-repo/src/auth.ts', '2026-05-12T09:01:00Z', 'u3', 20, 4),
        cc.turnDuration(120000, '2026-05-12T09:02:00Z', 's1'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      const r = await c.parse(files[0] as never, ctx());
      const kinds = r.events.map((e) => e.kind);

      assert.ok(kinds.includes('user.instruction'));
      assert.ok(kinds.includes('assistant.message'));
      assert.ok(kinds.includes('test.run'), 'npm test must classify as a test run');
      assert.ok(kinds.includes('file.modified'));
      assert.ok(kinds.includes('tokens.reported'));
      assert.ok(kinds.includes('turn.completed'));

      const edit = r.events.find((e) => e.kind === 'file.modified');
      assert.equal(edit?.payload.files?.[0]?.linesAdded, 20);
      assert.equal(edit?.payload.files?.[0]?.linesRemoved, 4);

      const turn = r.events.find((e) => e.kind === 'turn.completed');
      assert.equal(turn?.payload.durationMs, 120000, 'turn duration is measured, not inferred');

      assert.equal(r.health.recordsMalformed, 0);
      assert.deepEqual(r.health.unknownTypes, {});
      assert.equal(r.sessions.length, 1);
      assert.equal(r.sessions[0]?.cwd, '/tmp/fixture-repo');
      assert.equal(r.bytesConsumed, fs.statSync(file).size);
    } finally {
      cleanup(home);
    }
  });

  test('classifies build, lint and typecheck commands distinctly', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.bash('npm run build', '2026-05-12T09:00:00Z', 'a1', 't1'),
        cc.bash('eslint src', '2026-05-12T09:00:01Z', 'a2', 't2'),
        cc.bash('tsc --noEmit', '2026-05-12T09:00:02Z', 'a3', 't3'),
        cc.bash('git status', '2026-05-12T09:00:03Z', 'a4', 't4'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const kinds = r.events.filter((e) => e.payload.command).map((e) => e.kind);
      assert.deepEqual(kinds, ['build.run', 'lint.run', 'typecheck.run', 'shell.command']);
    } finally {
      cleanup(home);
    }
  });

  test('records a human interrupt as a distinct event', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.user('[Request interrupted by user for tool use]', '2026-05-12T09:00:00Z', 'u1'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.events[0]?.kind, 'user.interrupt');
    } finally {
      cleanup(home);
    }
  });

  test('treats human edits outside the agent as attribution evidence', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        {
          type: 'attachment',
          uuid: 'x1',
          timestamp: '2026-05-12T09:00:00Z',
          attachment: {
            type: 'edited_text_file',
            filename: '/tmp/fixture-repo/src/a.ts',
            snippet: 'x',
          },
        },
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const e = r.events.find((x) => x.kind === 'file.modified');
      assert.equal(e?.payload.reason, 'human-edit');
    } finally {
      cleanup(home);
    }
  });
});

/* ================================================================== */
/* Codex discovery & parsing                                           */
/* ================================================================== */

describe('Codex session discovery', () => {
  test('walks the YYYY/MM/DD layout and extracts the session id from the filename', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [], { date: '2026-05-12' });
      writeCodexRollout(home, [], {
        date: '2026-06-01',
        sessionId: '019e0000-0000-7000-8000-000000000002',
      });
      const c = new CodexCollector(home);
      const files = await c.discover();
      assert.equal(files.length, 2);
      assert.ok(files.every((f) => f.sessionHint));
      const det = await c.detect();
      assert.equal(det.installed, true);
      assert.deepEqual(det.dataDirs, [path.join(home, 'sessions')]);
    } finally {
      cleanup(home);
    }
  });

  test('honours CODEX_HOME and reports absence cleanly', async () => {
    const home = tmpDir();
    try {
      const c = new CodexCollector(path.join(home, 'absent'));
      const det = await c.detect();
      assert.equal(det.installed, false);
      assert.ok(det.notes.some((n) => n.includes('CODEX_HOME')));
    } finally {
      cleanup(home);
    }
  });
});

describe('Codex transcript parsing', () => {
  test('parses the modern event_msg shape with exit codes and durations', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [
        cx.userMessage('Fix pagination', '2026-05-12T09:00:00Z'),
        cx.execEnd('pytest tests/', 0, '2026-05-12T09:00:20Z', 'c1'),
        cx.patchApplyEnd(
          '/tmp/fixture-repo/api/pagination.py',
          'update',
          '--- a\n+++ b\n+fixed\n+again\n-broken\n',
          '2026-05-12T09:00:40Z',
          'c2',
        ),
        cx.taskComplete(45000, '2026-05-12T09:01:00Z', 'turn1'),
      ]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const kinds = r.events.map((e) => e.kind);

      assert.ok(kinds.includes('user.instruction'));
      assert.ok(kinds.includes('test.run'));
      assert.ok(kinds.includes('file.modified'));
      assert.ok(kinds.includes('turn.completed'));

      const testRun = r.events.find((e) => e.kind === 'test.run');
      assert.equal(testRun?.payload.exitCode, 0);
      assert.equal(testRun?.payload.outcome, 'pass');
      assert.equal(testRun?.payload.command, 'pytest tests/', 'shell wrapper must be stripped');

      const patch = r.events.find((e) => e.kind === 'file.modified');
      assert.equal(patch?.payload.files?.[0]?.linesAdded, 2);
      assert.equal(patch?.payload.files?.[0]?.linesRemoved, 1);

      const turn = r.events.find((e) => e.kind === 'turn.completed' && e.payload.durationMs);
      assert.equal(turn?.payload.durationMs, 45000);
      assert.equal(r.health.recordsMalformed, 0);
    } finally {
      cleanup(home);
    }
  });

  test('falls back to function_call when the version emits no exec_command_end', async () => {
    // Codex 0.13x records shell execution only as response_item/function_call
    // plus an output whose preamble carries the exit code.
    const home = tmpDir();
    try {
      writeCodexRollout(
        home,
        [
          cx.execCall('pytest tests/', '2026-05-12T09:00:00Z', 'call_A'),
          cx.execOutput(1, 'E   assert False', '2026-05-12T09:00:30Z', 'call_A'),
        ],
        { cliVersion: '0.133.0-alpha.1' },
      );
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const testRun = r.events.find((e) => e.kind === 'test.run');
      assert.ok(testRun, 'the command must not be lost on older versions');
      assert.equal(testRun?.payload.exitCode, 1, 'exit code parsed from the output preamble');
      assert.equal(testRun?.payload.outcome, 'fail');
      assert.equal(testRun?.payload.durationMs, 421);
    } finally {
      cleanup(home);
    }
  });

  test('does not double count when both shapes are present for one call id', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [
        cx.execCall('pytest tests/', '2026-05-12T09:00:00Z', 'call_B'),
        cx.execEnd('pytest tests/', 0, '2026-05-12T09:00:10Z', 'call_B'),
        cx.execOutput(0, 'ok', '2026-05-12T09:00:11Z', 'call_B'),
      ]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const testRuns = r.events.filter((e) => e.kind === 'test.run');
      assert.equal(testRuns.length, 1, 'reconciliation must keep exactly one');
      assert.equal(testRuns[0]?.payload.rawType, 'exec_command_end', 'the richer record wins');
      assert.ok(r.health.recordsDuplicate > 0);
    } finally {
      cleanup(home);
    }
  });

  test('parses the apply_patch envelope into file changes', async () => {
    const home = tmpDir();
    try {
      const patch = [
        '*** Begin Patch',
        '*** Add File: src/new.ts',
        '+export const a = 1;',
        '+export const b = 2;',
        '*** Update File: src/old.ts',
        '@@',
        '-const x = 1;',
        '+const x = 2;',
        '*** End Patch',
      ].join('\n');
      writeCodexRollout(home, [cx.applyPatchCall(patch, '2026-05-12T09:00:00Z', 'p1')]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const e = r.events.find((x) => x.kind === 'file.created');
      assert.ok(e);
      const files = e?.payload.files ?? [];
      assert.equal(files.length, 2);
      assert.equal(files[0]?.changeType, 'add');
      assert.equal(files[0]?.linesAdded, 2);
      assert.equal(files[1]?.changeType, 'update');
      assert.equal(files[1]?.linesAdded, 1);
      assert.equal(files[1]?.linesRemoved, 1);
      assert.ok(
        files[0]?.path.startsWith('/tmp/fixture-repo/'),
        'relative paths resolve against cwd',
      );
    } finally {
      cleanup(home);
    }
  });

  test('turn_aborted becomes a human interrupt', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [cx.turnAborted('2026-05-12T09:00:00Z', 't1')]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.ok(
        r.events.some((e) => e.kind === 'user.interrupt' && e.payload.reason === 'interrupted'),
      );
    } finally {
      cleanup(home);
    }
  });

  test('developer and system role messages are not counted as human instructions', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [
        {
          timestamp: '2026-05-12T09:00:00Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'developer',
            content: [{ type: 'input_text', text: 'You are Codex.' }],
          },
        },
      ]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.events.filter((e) => e.kind === 'user.instruction').length, 0);
    } finally {
      cleanup(home);
    }
  });
});

/* ================================================================== */
/* Robustness: malformed input and unknown schemas                     */
/* ================================================================== */

describe('malformed and unknown input', () => {
  test('skips malformed JSONL lines and counts them, without throwing', async () => {
    const home = tmpDir();
    try {
      const file = writeClaudeTranscript(home, [cc.user('ok', '2026-05-12T09:00:00Z', 'u1')]);
      fs.appendFileSync(file, '{ this is not json\n');
      fs.appendFileSync(file, 'null\n');
      fs.appendFileSync(file, '[]\n');
      fs.appendFileSync(
        file,
        `${JSON.stringify({ type: 'user', uuid: 'u2', timestamp: '2026-05-12T09:00:10Z', message: { role: 'user', content: 'still fine' } })}\n`,
      );

      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.health.recordsMalformed, 3, 'non-object and unparsable lines are malformed');
      assert.equal(
        r.events.filter((e) => e.kind === 'user.instruction').length,
        2,
        'good records still parse',
      );
    } finally {
      cleanup(home);
    }
  });

  test('unknown record types are counted, never fatal', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        {
          type: 'some-future-record',
          uuid: 'z1',
          timestamp: '2026-05-12T09:00:00Z',
          payload: { a: 1 },
        },
        cc.user('hello', '2026-05-12T09:00:01Z', 'u1'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.health.unknownTypes['some-future-record'], 1);
      assert.equal(r.events.filter((e) => e.kind === 'user.instruction').length, 1);
    } finally {
      cleanup(home);
    }
  });

  test('unknown provider versions parse without special-casing', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [cc.user('hi', '2026-05-12T09:00:00Z', 'u1')], {
        version: '99.0.0-future',
      });
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.events.length > 0, true);
      assert.equal(r.health.providerVersions['99.0.0-future'], 1);
    } finally {
      cleanup(home);
    }
  });

  test('records without a usable timestamp are ignored rather than dated to the epoch', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        { type: 'user', uuid: 'u1', message: { role: 'user', content: 'no timestamp' } },
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.events.length, 0);
      assert.ok(r.health.recordsIgnored > 0);
    } finally {
      cleanup(home);
    }
  });

  test('a Codex record with no payload is counted as unknown, not crashed on', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [{ timestamp: '2026-05-12T09:00:00Z', type: 'event_msg' }]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.ok(Object.keys(r.health.unknownTypes).length > 0);
    } finally {
      cleanup(home);
    }
  });
});

/* ================================================================== */
/* Streaming reader                                                    */
/* ================================================================== */

describe('JSONL streaming', () => {
  test('never yields a partial trailing line and does not advance past it', async () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'x.jsonl');
      fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"a":3'); // last line incomplete
      const seen: string[] = [];
      const r = await scanJsonl(file, 0, 0, (l) => {
        seen.push(l.raw);
      });
      assert.deepEqual(seen, ['{"a":1}', '{"a":2}']);
      assert.equal(r.hadPartialTail, true);
      assert.equal(r.bytesConsumed, 16, 'cursor stops at the last complete newline');

      // Completing the line makes it available on the next pass.
      fs.appendFileSync(file, '}\n');
      const seen2: string[] = [];
      await scanJsonl(file, r.bytesConsumed, r.linesConsumed, (l) => {
        seen2.push(l.raw);
      });
      assert.deepEqual(seen2, ['{"a":3}']);
    } finally {
      cleanup(dir);
    }
  });

  test('handles a line larger than the read buffer', async () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'big.jsonl');
      const big = 'x'.repeat(3 * 1024 * 1024);
      fs.writeFileSync(file, `${JSON.stringify({ big })}\n{"small":1}\n`);
      const lens: number[] = [];
      await scanJsonl(file, 0, 0, (l) => {
        lens.push(l.raw.length);
      });
      assert.equal(lens.length, 2);
      assert.ok((lens[0] as number) > 3_000_000, 'multi-megabyte line survives chunk boundaries');
    } finally {
      cleanup(dir);
    }
  });

  test('resuming from a byte offset yields only new lines', async () => {
    const dir = tmpDir();
    try {
      const file = path.join(dir, 'r.jsonl');
      fs.writeFileSync(file, '{"a":1}\n');
      const first = await scanJsonl(file, 0, 0, () => {});
      fs.appendFileSync(file, '{"a":2}\n{"a":3}\n');
      const seen: string[] = [];
      const second = await scanJsonl(file, first.bytesConsumed, first.linesConsumed, (l) =>
        seen.push(l.raw),
      );
      assert.deepEqual(seen, ['{"a":2}', '{"a":3}']);
      assert.equal(second.linesConsumed, 3);
    } finally {
      cleanup(dir);
    }
  });
});

/* ================================================================== */
/* Incremental ingestion at the collector level                        */
/* ================================================================== */

describe('incremental file parsing', () => {
  test('parsing from a cursor returns only the appended records', async () => {
    const home = tmpDir();
    try {
      const file = writeClaudeTranscript(home, [cc.user('first', '2026-05-12T09:00:00Z', 'u1')]);
      const c = new ClaudeCodeCollector(home);
      const f1 = (await c.discover())[0] as never;
      const r1 = await c.parse(f1, ctx());
      assert.equal(r1.events.filter((e) => e.kind === 'user.instruction').length, 1);

      appendClaudeTranscript(file, [cc.user('second', '2026-05-12T09:05:00Z', 'u2')]);
      const f2 = (await c.discover())[0] as never;
      const r2 = await c.parse(f2, ctx({ fromByte: r1.bytesConsumed, fromLine: r1.linesConsumed }));
      const texts = r2.events
        .filter((e) => e.kind === 'user.instruction')
        .map((e) => e.payload.text);
      assert.deepEqual(texts, ['second'], 'the first record must not be re-emitted');
    } finally {
      cleanup(home);
    }
  });

  test('event ids are stable across re-parses, making re-ingestion idempotent', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.user('a', '2026-05-12T09:00:00Z', 'u1'),
        cc.bash('npm test', '2026-05-12T09:00:10Z', 'a1'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const f = (await c.discover())[0] as never;
      const first = (await c.parse(f, ctx())).events.map((e) => e.id);
      const second = (await c.parse(f, ctx())).events.map((e) => e.id);
      assert.deepEqual(first, second);
    } finally {
      cleanup(home);
    }
  });
});

/* ================================================================== */
/* Compaction & replay                                                 */
/* ================================================================== */

describe('compaction and resumed sessions', () => {
  test('a repeated uuid inside one transcript is flagged as replay, not new work', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.user('build the thing', '2026-05-12T09:00:00Z', 'u1'),
        cc.compactBoundary('2026-05-12T09:30:00Z', 'sys1'),
        // Claude Code replays a summarised prefix after compaction.
        cc.user('build the thing', '2026-05-12T09:30:01Z', 'u1'),
        cc.user('now add tests', '2026-05-12T09:31:00Z', 'u2'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const instructions = r.events.filter((e) => e.kind === 'user.instruction');
      const counted = instructions.filter((e) => !e.isReplay);
      assert.equal(instructions.length, 3);
      assert.equal(counted.length, 2, 'the replayed record must not be counted');
      assert.ok(r.health.recordsDuplicate >= 1);
      assert.ok(r.events.some((e) => e.kind === 'session.compacted'));
    } finally {
      cleanup(home);
    }
  });

  test('Codex compaction records do not re-ingest replacement history', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [
        cx.userMessage('original ask', '2026-05-12T09:00:00Z'),
        {
          timestamp: '2026-05-12T09:30:00Z',
          type: 'compacted',
          payload: {
            message: '',
            // A whole prior conversation, replayed. Must not become events.
            replacement_history: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'original ask' }],
              },
            ],
            window_number: 1,
          },
        },
      ]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const instructions = r.events.filter((e) => e.kind === 'user.instruction' && !e.isReplay);
      assert.equal(instructions.length, 1, 'replacement_history is never parsed as new events');
      assert.ok(r.events.some((e) => e.kind === 'session.compacted'));
    } finally {
      cleanup(home);
    }
  });

  test('a forked Codex session records its parent', async () => {
    const home = tmpDir();
    try {
      const dir = path.join(home, 'sessions', '2026', '05', '12');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(
        dir,
        'rollout-2026-05-12T09-00-00-019e0000-0000-7000-8000-00000000000f.jsonl',
      );
      fs.writeFileSync(
        file,
        `${JSON.stringify({
          timestamp: '2026-05-12T09:00:00Z',
          type: 'session_meta',
          payload: {
            session_id: '019e0000-0000-7000-8000-00000000000f',
            cwd: '/tmp/fixture-repo',
            cli_version: '0.146.0',
            forked_from_id: 'parent-thread',
            git: {
              branch: 'feature/x',
              commit_hash: 'abc123',
              repository_url: 'https://example.com/r.git',
            },
          },
        })}\n`,
      );
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.sessions[0]?.kind, 'fork');
      assert.equal(r.sessions[0]?.parentSessionId, 'parent-thread');
      assert.equal(r.sessions[0]?.branch, 'feature/x');
      assert.ok(r.events.some((e) => e.kind === 'session.forked'));
      assert.ok(
        r.events.some((e) => e.kind === 'git.observed' && e.payload.commitHash === 'abc123'),
      );
    } finally {
      cleanup(home);
    }
  });
});

/* ================================================================== */
/* Subagents — delegated parallel work                                 */
/* ================================================================== */

describe('Claude Code subagent transcripts', () => {
  test('discovers nested subagent and workflow transcripts', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [cc.user('build it', '2026-05-12T09:00:00Z', 'u1')]);
      writeClaudeSubagent(home, [cc.user('sub task', '2026-05-12T09:01:00Z', 's1')], {
        agentId: 'aaa111',
      });
      writeClaudeSubagent(home, [cc.user('wf task', '2026-05-12T09:02:00Z', 's2')], {
        agentId: 'bbb222',
        workflow: 'wf_deadbeef',
      });

      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      assert.equal(
        files.length,
        3,
        'top-level, subagents/, and subagents/workflows/ are all found',
      );
      assert.ok(files.some((f) => f.path.includes('/subagents/agent-aaa111.jsonl')));
      assert.ok(files.some((f) => f.path.includes('/workflows/wf_deadbeef/agent-bbb222.jsonl')));
    } finally {
      cleanup(home);
    }
  });

  test('a subagent gets its own session identity, linked to its parent', async () => {
    const home = tmpDir();
    try {
      const parent = '11111111-2222-3333-4444-555555555555';
      writeClaudeSubagent(
        home,
        [
          cc.user('Refactor the parser module', '2026-05-12T09:00:00Z', 's1'),
          cc.edit('/tmp/fixture-repo/src/parse.ts', '2026-05-12T09:02:00Z', 's2', 40, 10),
        ],
        { sessionId: parent, agentId: 'aaa111' },
      );
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());

      assert.equal(r.sessions.length, 1);
      const seed = r.sessions[0];
      assert.equal(seed?.kind, 'subagent');
      assert.equal(seed?.parentSessionId, parent);
      assert.notEqual(
        seed?.sessionId,
        parent,
        'a subagent must not collapse into the parent channel',
      );
      assert.ok(seed?.sessionId.includes('agent-aaa111'));
      assert.ok(
        r.events.every((e) => e.isSubagent),
        'every event is flagged as subagent work',
      );
      assert.ok(
        r.events.some((e) => e.kind === 'file.modified'),
        'delegated file changes are still captured',
      );
    } finally {
      cleanup(home);
    }
  });

  test('two subagents of one session form two distinct channels', async () => {
    const home = tmpDir();
    try {
      const parent = '11111111-2222-3333-4444-555555555555';
      for (const id of ['aaa111', 'bbb222']) {
        writeClaudeSubagent(home, [cc.user(`work ${id}`, '2026-05-12T09:00:00Z', `u-${id}`)], {
          sessionId: parent,
          agentId: id,
        });
      }
      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      const ids = new Set<string>();
      for (const f of files) {
        const r = await c.parse(f, ctx());
        for (const s of r.sessions) ids.add(s.sessionId);
      }
      assert.equal(ids.size, 2, 'parallel subagents must be separately countable');
    } finally {
      cleanup(home);
    }
  });
});

/* ================================================================== */
/* Codex message envelopes                                             */
/* ================================================================== */

describe('extracting the human request from Codex envelopes', () => {
  test('takes the tail after the explicit request marker', () => {
    const raw = [
      '',
      '# Chrome tabs:',
      '- The user has the Chrome extension side panel open.',
      '- Current URL: https://example.com/x',
      '',
      '## My request for Codex:',
      'find the memory leak in the worker pool',
      '',
    ].join('\n');
    assert.equal(extractUserRequest(raw), 'find the memory leak in the worker pool');
  });

  test('drops multiple synthetic sections when no marker is present', () => {
    const raw = [
      '# Files mentioned by the user:',
      '',
      '## something.txt: /tmp/a.txt',
      '',
      '# Chrome tabs:',
      '- tab context',
      '',
      'now refactor the parser',
    ].join('\n');
    const out = extractUserRequest(raw);
    assert.ok(out.includes('refactor the parser'));
    assert.ok(!out.includes('Chrome tabs'));
    assert.ok(!out.includes('Files mentioned'));
  });

  test('a message that is only synthetic context yields nothing', () => {
    const raw = ['', '# Chrome tabs:', '- The user has the side panel open.', ''].join('\n');
    assert.equal(extractUserRequest(raw), '');
  });

  test('an ordinary message is returned untouched', () => {
    assert.equal(extractUserRequest('fix the failing test'), 'fix the failing test');
    assert.equal(extractUserRequest(''), '');
  });

  test('envelope-only messages never become tasks', async () => {
    const home = tmpDir();
    try {
      writeCodexRollout(home, [
        cx.userMessage(
          '\n# Chrome tabs:\n- The user has the side panel open.\n',
          '2026-05-12T09:00:00Z',
        ),
        cx.userMessage(
          '\n# Chrome tabs:\n- tab\n\n## My request for Codex:\nadd rate limiting\n',
          '2026-05-12T09:01:00Z',
        ),
      ]);
      const c = new CodexCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const instructions = r.events.filter((e) => e.kind === 'user.instruction');
      assert.equal(instructions.length, 1, 'only the message with a real request counts');
      assert.equal(instructions[0]?.payload.text, 'add rate limiting');
    } finally {
      cleanup(home);
    }
  });
});

/* ================================================================== */
/* Command outcome correlation                                         */
/* ================================================================== */

describe('joining Claude Code command results to their commands', () => {
  test('a passing test run is recorded as passing on the test.run event', async () => {
    // Claude Code splits these across two records. If they are not joined, a
    // green suite is invisible to verification and nothing ever reaches
    // "completed-validated".
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.bash('python3 -m pytest test_calc.py -q', '2026-05-12T09:00:00Z', 'a1', 'call_t1'),
        cc.bashResult('...  [100%]\n3 passed in 0.01s', '2026-05-12T09:00:20Z', 'u1', 'call_t1'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const run = r.events.find((e) => e.kind === 'test.run');
      assert.ok(run, 'the command is classified as a test run');
      assert.equal(run?.payload.outcome, 'pass', 'and its outcome is attached');
    } finally {
      cleanup(home);
    }
  });

  test('a failing test run is recorded as failing', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.bash('npm test', '2026-05-12T09:00:00Z', 'a1', 'call_t2'),
        cc.bashResult(
          '1 failed, 2 passed\nAssertionError',
          '2026-05-12T09:00:20Z',
          'u1',
          'call_t2',
        ),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.events.find((e) => e.kind === 'test.run')?.payload.outcome, 'fail');
    } finally {
      cleanup(home);
    }
  });

  test('outcomes are matched by tool-call id, not by order', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.bash('npm test', '2026-05-12T09:00:00Z', 'a1', 'call_A'),
        cc.bash('npm run build', '2026-05-12T09:00:01Z', 'a2', 'call_B'),
        // Results arrive out of order.
        cc.bashResult('Compiled successfully', '2026-05-12T09:00:30Z', 'u2', 'call_B'),
        cc.bashResult('4 passed', '2026-05-12T09:00:40Z', 'u1', 'call_A'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      assert.equal(r.events.find((e) => e.kind === 'test.run')?.payload.outcome, 'pass');
      assert.equal(r.events.find((e) => e.kind === 'build.run')?.payload.outcome, 'pass');
    } finally {
      cleanup(home);
    }
  });

  test('a passing suite after the last edit reaches completed-validated end to end', async () => {
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [
        cc.user('Fix the off-by-one in paginate', '2026-05-12T09:00:00Z', 'u0'),
        cc.edit('/tmp/fixture-repo/calc.py', '2026-05-12T09:01:00Z', 'u1', 2, 2),
        cc.bash('python3 -m pytest -q', '2026-05-12T09:02:00Z', 'a1', 'call_x'),
        cc.bashResult('3 passed in 0.01s', '2026-05-12T09:02:30Z', 'u2', 'call_x'),
      ]);
      const c = new ClaudeCodeCollector(home);
      const r = await c.parse((await c.discover())[0] as never, ctx());
      const seg = reconstructTasks(r.events)[0];
      assert.ok(seg);
      const evd = extractEvidence(seg as never, '/tmp/fixture-repo');
      assert.equal(evd.testsRun, 1);
      assert.equal(evd.testsPassed, 1, 'the passing run must be counted');
      const v = verifyOutcome({
        events: seg!.events,
        evidence: evd,
        paths: ['/tmp/fixture-repo/calc.py'],
        repoIsGit: false,
        taskStart: seg!.startedAt,
        taskEnd: seg!.endedAt,
        skipFsChecks: true,
      });
      assert.equal(v.status, 'completed-validated');
    } finally {
      cleanup(home);
    }
  });
});
