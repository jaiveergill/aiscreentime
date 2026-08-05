import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeCodeCollector } from '../../src/collectors/claude/index.ts';
import { CodexCollector } from '../../src/collectors/codex/index.ts';
import type { ParseContext } from '../../src/collectors/types.ts';
import { cleanup, tmpDir, writeClaudeTranscript, writeCodexRollout } from '../helpers.ts';

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

/**
 * The two providers report cached input on opposite conventions, so `tokensIn`
 * is normalised at the collector to mean the same thing for both: every token
 * the model was fed. Taking either field at face value produces a cross-provider
 * total that is wrong by orders of magnitude, and nothing downstream could tell.
 */
describe('token normalisation across providers', () => {
  test('Claude cache reads count as input', async () => {
    // A cached Claude turn reports input_tokens=2 against 20k actually read
    // from cache. Trusting input_tokens alone would report ~0.01% of the truth.
    const home = tmpDir();
    try {
      const file = writeClaudeTranscript(home, [
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-05-12T09:00:00Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'ok' }],
            usage: {
              input_tokens: 2,
              output_tokens: 109,
              cache_read_input_tokens: 20_729,
              cache_creation_input_tokens: 17_883,
            },
          },
        },
      ]);
      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      const r = await c.parse(files[0] as never, ctx());
      const ev = r.events.find((e) => e.kind === 'tokens.reported');
      assert.ok(ev, 'a usage event is emitted');
      assert.equal(
        ev.payload.tokensIn,
        2 + 20_729 + 17_883,
        'input must include both cache read and cache creation',
      );
      assert.equal(ev.payload.tokensOut, 109);
      assert.equal(ev.payload.tokensCacheRead, 20_729, 'the cached share stays available');
    } finally {
      cleanup(home);
    }
  });

  test('Codex cached input is a breakdown, not an addend', async () => {
    // Codex reports input_tokens already inclusive of cached_input_tokens —
    // input + output == total_tokens. Adding the cached figure the way Claude
    // requires would double-count it.
    const home = tmpDir();
    try {
      const file = writeCodexRollout(home, [
        {
          timestamp: '2026-05-12T09:00:01.000Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            info: {
              total_token_usage: {
                input_tokens: 5154,
                cached_input_tokens: 3072,
                output_tokens: 39,
                reasoning_output_tokens: 0,
                total_tokens: 5193,
              },
              last_token_usage: {
                input_tokens: 5154,
                cached_input_tokens: 3072,
                output_tokens: 39,
                reasoning_output_tokens: 0,
                total_tokens: 5193,
              },
            },
          },
        },
      ]);
      const c = new CodexCollector(home);
      const files = await c.discover();
      const r = await c.parse(files[0] as never, ctx());
      const ev = r.events.find((e) => e.kind === 'tokens.reported');
      assert.ok(ev, 'a usage event is emitted');
      assert.equal(ev.payload.tokensIn, 5154, 'cached input is already inside input_tokens');
      assert.equal(ev.payload.tokensOut, 39);
      assert.equal(
        (ev.payload.tokensIn ?? 0) + (ev.payload.tokensOut ?? 0),
        5193,
        'the normalised split still reconciles with the provider total',
      );
    } finally {
      cleanup(home);
    }
  });

  test('a turn with no usage block reports nothing rather than zero', async () => {
    const home = tmpDir();
    try {
      const file = writeClaudeTranscript(home, [
        {
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-05-12T09:00:00Z',
          message: {
            role: 'assistant',
            model: 'claude-opus-5',
            content: [{ type: 'text', text: 'hi' }],
          },
        },
      ]);
      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      const r = await c.parse(files[0] as never, ctx());
      assert.equal(
        r.events.find((e) => e.kind === 'tokens.reported'),
        undefined,
        'absent usage must not be recorded as a measured zero',
      );
    } finally {
      cleanup(home);
    }
  });
});

/**
 * Claude Code writes JSONL while the response is still streaming, so one API
 * request emits several records under the same `requestId`, each repeating the
 * same cache figures with a rising output count. Counting them all inflated
 * input by exactly 2.00x on real history.
 */
describe('streaming repeats count as one request', () => {
  const usage = (out: number) => ({
    input_tokens: 1,
    output_tokens: out,
    cache_read_input_tokens: 20_000,
    cache_creation_input_tokens: 0,
  });
  const entry = (uuid: string, out: number) => ({
    type: 'assistant',
    uuid,
    timestamp: '2026-05-12T09:00:00Z',
    requestId: 'req_same',
    message: {
      id: 'msg_same',
      role: 'assistant',
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: usage(out),
    },
  });

  test('repeats collapse to one event carrying the highest output', async () => {
    const home = tmpDir();
    try {
      // Four streaming records for a single request, output climbing.
      const file = writeClaudeTranscript(home, [
        entry('a1', 10),
        entry('a2', 40),
        entry('a3', 90),
        entry('a4', 120),
      ]);
      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      const r = await c.parse(files[0] as never, ctx());
      const usageEvents = r.events.filter((e) => e.kind === 'tokens.reported');

      assert.equal(usageEvents.length, 1, 'one request must produce one usage event');
      assert.equal(
        usageEvents[0]?.payload.tokensIn,
        20_001,
        'cache tokens counted once, not once per streamed record',
      );
      assert.equal(
        usageEvents[0]?.payload.tokensOut,
        120,
        'output takes the final, highest value rather than the first',
      );
    } finally {
      cleanup(home);
    }
  });

  test('the same request arriving in a second file is not counted twice', async () => {
    // A subagent's response is written to both the parent transcript and its
    // own agent-*.jsonl. The shared parse context must recognise the repeat.
    const home = tmpDir();
    try {
      writeClaudeTranscript(home, [entry('a1', 120)], {
        sessionId: 'aaaaaaaa-1111-4111-8111-111111111111',
      });
      writeClaudeTranscript(home, [entry('b1', 120)], {
        sessionId: 'bbbbbbbb-2222-4222-8222-222222222222',
      });
      const c = new ClaudeCodeCollector(home);
      const files = await c.discover();
      const shared = ctx();
      let total = 0;
      for (const f of files) {
        const r = await c.parse(f as never, shared);
        total += r.events.filter((e) => e.kind === 'tokens.reported').length;
      }
      assert.equal(total, 1, 'the request is counted once across both transcripts');
    } finally {
      cleanup(home);
    }
  });
});
