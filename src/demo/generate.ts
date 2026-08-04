import type { EventKind, EventPayload, NormalizedEvent, ProviderId } from '../core/types.ts';
import { hashId } from '../core/util.ts';
import type { Db } from '../store/db.ts';

/**
 * Synthetic evaluation dataset.
 *
 * This is both the demo dataset shown when no provider is installed and the
 * fixture the evaluation suite asserts against. It deliberately contains every
 * hard case the reconstruction and verification logic must get right:
 *
 *   1. a completed feature with strong test validation
 *   2. a subtle bug fix (small diff, high error count, tests pass)
 *   3. a refactor (balanced add/remove, no new files)
 *   4. a research task (reads only, no writes)
 *   5. a failed implementation (tests never pass)
 *   6. a reverted implementation (work later reverted)
 *   7. one task continued across providers (Codex → Claude Code)
 *   8. a task with interleaved human edits (ambiguous attribution)
 *   9. two tasks running concurrently (parallelism)
 *  10. a non-engineering conversation that must be excluded entirely
 *  11. a boilerplate-heavy scaffold that must be discounted
 *  12. a resumed session whose replayed prefix must not be double-counted
 *
 * Expected outcomes are asserted in `test/e2e/fixture.test.ts`.
 */

const DAY = 24 * 3600_000;

/** Fixed base instant so the fixture is fully deterministic. */
export const DEMO_BASE = Date.UTC(2026, 4, 12, 9, 0, 0);

let seq = 0;

interface Builder {
  session: string;
  provider: ProviderId;
  cwd: string;
  t: number;
  events: NormalizedEvent[];
}

function mk(
  b: Builder,
  kind: EventKind,
  dtSeconds: number,
  payload: EventPayload,
  opts?: { replay?: boolean; subagent?: boolean },
): void {
  b.t += dtSeconds * 1000;
  seq++;
  b.events.push({
    id: hashId('demo', b.session, seq, kind),
    sessionId: b.session,
    provider: b.provider,
    kind,
    ts: b.t,
    cwd: b.cwd,
    isSubagent: opts?.subagent ?? false,
    isReplay: opts?.replay ?? false,
    payload: { ...payload, rawType: 'demo' },
    provenance: {
      provider: b.provider,
      sourceFile: `demo://${b.provider}/${b.session}.jsonl`,
      lineIndex: seq,
      byteOffset: seq * 120,
      parser: 'demo/v1',
      providerVersion: 'demo',
    },
  });
}

function file(
  p: string,
  type: 'add' | 'update' | 'delete',
  added: number,
  removed: number,
  generated = false,
) {
  return {
    path: p,
    changeType: type,
    linesAdded: added,
    linesRemoved: removed,
    generated,
    binary: false,
  };
}

export interface DemoScenario {
  readonly key: string;
  readonly description: string;
  readonly expect: {
    readonly becomesTask: boolean;
    readonly category?: string;
    readonly status?: string;
    /** Ordering constraint: this scenario's verified hours must exceed these. */
    readonly moreThan?: readonly string[];
  };
}

export const DEMO_SCENARIOS: DemoScenario[] = [
  {
    key: 'feature-tested',
    description: 'Password reset feature, 6 files, tests written and passing',
    expect: {
      becomesTask: true,
      status: 'completed-validated',
      moreThan: ['bugfix', 'research', 'failed'],
    },
  },
  {
    key: 'bugfix',
    description: 'Subtle off-by-one fix, 1 file, 4 errors, tests pass',
    expect: { becomesTask: true, status: 'completed-validated' },
  },
  {
    key: 'refactor',
    description: 'Extract parser module, balanced add/remove',
    expect: { becomesTask: true, category: 'refactoring' },
  },
  {
    key: 'research',
    description: 'Read the auth subsystem to understand token flow',
    expect: { becomesTask: true, category: 'research', status: 'exploratory' },
  },
  {
    key: 'failed',
    description: 'Attempted websocket layer, tests never pass',
    expect: { becomesTask: true, status: 'partial' },
  },
  {
    key: 'reverted',
    description: 'Cache layer added then reverted',
    expect: { becomesTask: true },
  },
  {
    key: 'cross-provider',
    description: 'Migration started in Codex, finished in Claude Code',
    expect: { becomesTask: true },
  },
  {
    key: 'human-edited',
    description: 'Agent change plus direct human edits to the same files',
    expect: { becomesTask: true },
  },
  {
    key: 'concurrent-a',
    description: 'Runs at the same time as concurrent-b',
    expect: { becomesTask: true },
  },
  {
    key: 'concurrent-b',
    description: 'Runs at the same time as concurrent-a',
    expect: { becomesTask: true },
  },
  { key: 'chat', description: 'Non-engineering conversation', expect: { becomesTask: false } },
  {
    key: 'boilerplate',
    description: 'Large generated scaffold, no tests',
    expect: { becomesTask: true },
  },
];

/** Build the full synthetic event set. Deterministic across runs. */
export function generateDemoEvents(baseTs = DEMO_BASE): NormalizedEvent[] {
  seq = 0;
  const all: NormalizedEvent[] = [];
  const repoA = '/demo/acme-web';
  const repoB = '/demo/acme-api';

  // --- 1. completed feature with strong validation ------------------------
  {
    const b: Builder = {
      session: 'demo-cc-feature',
      provider: 'claude-code',
      cwd: repoA,
      t: baseTs,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'Implement password reset: request a token by email, verify it, and let the user set a new password. Add tests.',
    });
    mk(b, 'file.read', 40, { paths: [`${repoA}/src/auth/session.ts`] });
    mk(b, 'file.read', 20, { paths: [`${repoA}/src/auth/user.ts`] });
    mk(b, 'file.created', 180, {
      files: [file(`${repoA}/src/auth/reset.ts`, 'add', 164, 0)],
      paths: [`${repoA}/src/auth/reset.ts`],
    });
    mk(b, 'file.modified', 90, {
      files: [file(`${repoA}/src/auth/routes.ts`, 'update', 38, 4)],
      paths: [`${repoA}/src/auth/routes.ts`],
    });
    mk(b, 'file.modified', 60, {
      files: [file(`${repoA}/src/mail/templates.ts`, 'update', 26, 0)],
      paths: [`${repoA}/src/mail/templates.ts`],
    });
    mk(b, 'file.created', 150, {
      files: [file(`${repoA}/src/auth/reset.test.ts`, 'add', 118, 0)],
      paths: [`${repoA}/src/auth/reset.test.ts`],
    });
    mk(b, 'test.run', 45, { command: 'npm test', outcome: 'fail', exitCode: 1 });
    mk(b, 'error.encountered', 2, { text: 'expected 200, got 500' });
    mk(b, 'user.instruction', 120, { text: 'The token expiry check is inverted — fix it.' });
    mk(b, 'file.modified', 60, {
      files: [file(`${repoA}/src/auth/reset.ts`, 'update', 6, 6)],
      paths: [`${repoA}/src/auth/reset.ts`],
    });
    mk(b, 'test.run', 40, { command: 'npm test', outcome: 'pass', exitCode: 0 });
    mk(b, 'typecheck.run', 20, { command: 'npm run typecheck', outcome: 'pass', exitCode: 0 });
    mk(b, 'turn.completed', 5, { durationMs: 780_000 });
    mk(b, 'user.instruction', 90, { text: 'Perfect, that works. Ship it.' });
  }

  // --- 2. subtle bug fix ---------------------------------------------------
  {
    const b: Builder = {
      session: 'demo-cc-bugfix',
      provider: 'claude-code',
      cwd: repoB,
      t: baseTs + 2 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'Pagination returns a duplicate row on the last page. Find the bug and fix it.',
    });
    mk(b, 'search.performed', 20, { text: 'paginate' });
    mk(b, 'file.read', 15, { paths: [`${repoB}/api/pagination.py`] });
    mk(b, 'shell.command', 30, {
      command: 'python -m pytest tests/test_pagination.py -x',
      outcome: 'fail',
      exitCode: 1,
    });
    mk(b, 'error.encountered', 2, { text: 'AssertionError: duplicate id 41' });
    mk(b, 'shell.command', 60, {
      command: 'python -c "print(list(range(0,10,3)))"',
      outcome: 'pass',
      exitCode: 0,
    });
    mk(b, 'error.encountered', 30, { text: 'off-by-one in offset calculation' });
    mk(b, 'error.encountered', 25, { text: 'boundary case at total % limit == 0' });
    mk(b, 'file.modified', 60, {
      files: [file(`${repoB}/api/pagination.py`, 'update', 3, 3)],
      paths: [`${repoB}/api/pagination.py`],
    });
    mk(b, 'test.run', 30, { command: 'pytest tests/', outcome: 'pass', exitCode: 0 });
    mk(b, 'turn.completed', 5, { durationMs: 285_000 });
  }

  // --- 3. refactor ----------------------------------------------------------
  {
    const b: Builder = {
      session: 'demo-cx-refactor',
      provider: 'codex',
      cwd: repoA,
      t: baseTs + 4 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'Refactor the transcript parser: extract the record handlers into their own module and simplify the switch.',
    });
    mk(b, 'file.read', 20, { paths: [`${repoA}/src/parse/index.ts`] });
    mk(b, 'file.modified', 200, {
      files: [file(`${repoA}/src/parse/index.ts`, 'update', 42, 188)],
      paths: [`${repoA}/src/parse/index.ts`],
    });
    mk(b, 'file.modified', 120, {
      files: [file(`${repoA}/src/parse/handlers.ts`, 'update', 176, 20)],
      paths: [`${repoA}/src/parse/handlers.ts`],
    });
    mk(b, 'file.modified', 60, {
      files: [file(`${repoA}/src/parse/types.ts`, 'update', 14, 12)],
      paths: [`${repoA}/src/parse/types.ts`],
    });
    mk(b, 'typecheck.run', 30, { command: 'tsc --noEmit', outcome: 'pass', exitCode: 0 });
    mk(b, 'test.run', 40, { command: 'npm test', outcome: 'pass', exitCode: 0 });
    mk(b, 'turn.completed', 5, { durationMs: 470_000 });
  }

  // --- 4. research ----------------------------------------------------------
  {
    const b: Builder = {
      session: 'demo-cx-research',
      provider: 'codex',
      cwd: repoB,
      t: baseTs + 5 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'How does the token refresh flow work in this codebase? Trace it end to end and explain where the race condition could be.',
    });
    for (let i = 0; i < 9; i++) {
      mk(b, 'file.read', 25, { paths: [`${repoB}/api/auth/module_${i}.py`] });
    }
    mk(b, 'search.performed', 20, { text: 'refresh_token' });
    mk(b, 'search.performed', 15, { text: 'lock' });
    mk(b, 'shell.command', 20, {
      command: 'rg -n "refresh" --type py',
      outcome: 'pass',
      exitCode: 0,
    });
    mk(b, 'assistant.message', 30, { text: 'The refresh flow spans three modules…' });
    mk(b, 'turn.completed', 5, { durationMs: 340_000 });
  }

  // --- 5. failed implementation --------------------------------------------
  {
    const b: Builder = {
      session: 'demo-cc-failed',
      provider: 'claude-code',
      cwd: repoB,
      t: baseTs + 6 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'Add a websocket layer so clients get live updates instead of polling.',
    });
    mk(b, 'file.created', 150, {
      files: [file(`${repoB}/api/ws/server.py`, 'add', 210, 0)],
      paths: [`${repoB}/api/ws/server.py`],
    });
    mk(b, 'file.modified', 90, {
      files: [file(`${repoB}/api/app.py`, 'update', 22, 2)],
      paths: [`${repoB}/api/app.py`],
    });
    mk(b, 'test.run', 40, { command: 'pytest tests/test_ws.py', outcome: 'fail', exitCode: 1 });
    mk(b, 'error.encountered', 2, { text: 'ConnectionRefusedError' });
    mk(b, 'file.modified', 120, {
      files: [file(`${repoB}/api/ws/server.py`, 'update', 30, 24)],
      paths: [`${repoB}/api/ws/server.py`],
    });
    mk(b, 'test.run', 50, { command: 'pytest tests/test_ws.py', outcome: 'fail', exitCode: 1 });
    mk(b, 'error.encountered', 2, { text: 'ConnectionRefusedError' });
    mk(b, 'user.interrupt', 60, { reason: 'interrupted' });
    mk(b, 'user.instruction', 10, { text: "Stop, that's not working. Leave it for now." });
  }

  // --- 6. reverted implementation ------------------------------------------
  {
    const b: Builder = {
      session: 'demo-cx-reverted',
      provider: 'codex',
      cwd: repoA,
      t: baseTs + 7 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'Add a Redis cache in front of the product listing query.',
    });
    mk(b, 'file.created', 160, {
      files: [file(`${repoA}/src/cache/redis.ts`, 'add', 128, 0)],
      paths: [`${repoA}/src/cache/redis.ts`],
    });
    mk(b, 'file.modified', 90, {
      files: [file(`${repoA}/src/products/list.ts`, 'update', 24, 6)],
      paths: [`${repoA}/src/products/list.ts`],
    });
    mk(b, 'test.run', 40, { command: 'npm test', outcome: 'pass', exitCode: 0 });
    mk(b, 'turn.completed', 5, { durationMs: 300_000 });
    mk(b, 'user.instruction', 300, {
      text: 'Actually revert that — cache invalidation is going to bite us. Undo the whole thing.',
    });
    mk(b, 'file.deleted', 60, {
      files: [file(`${repoA}/src/cache/redis.ts`, 'delete', 0, 128)],
      paths: [`${repoA}/src/cache/redis.ts`],
    });
    mk(b, 'file.modified', 30, {
      files: [file(`${repoA}/src/products/list.ts`, 'update', 6, 24)],
      paths: [`${repoA}/src/products/list.ts`],
    });
  }

  // --- 7. cross-provider continuation ---------------------------------------
  {
    const b1: Builder = {
      session: 'demo-cx-migration',
      provider: 'codex',
      cwd: repoB,
      t: baseTs + 8 * 3600_000,
      events: all,
    };
    mk(b1, 'session.started', 0, {});
    mk(b1, 'user.instruction', 5, {
      text: 'Migrate the orders table to the new schema with a nullable currency column and a backfill.',
    });
    mk(b1, 'file.created', 200, {
      files: [file(`${repoB}/migrations/0042_orders_currency.sql`, 'add', 46, 0)],
      paths: [`${repoB}/migrations/0042_orders_currency.sql`],
    });
    mk(b1, 'file.modified', 120, {
      files: [file(`${repoB}/api/orders/model.py`, 'update', 34, 8)],
      paths: [`${repoB}/api/orders/model.py`],
    });
    mk(b1, 'shell.command', 60, { command: 'alembic upgrade head', outcome: 'pass', exitCode: 0 });
    mk(b1, 'turn.completed', 5, { durationMs: 400_000 });

    const b2: Builder = {
      session: 'demo-cc-migration',
      provider: 'claude-code',
      cwd: repoB,
      t: baseTs + 9 * 3600_000,
      events: all,
    };
    mk(b2, 'session.started', 0, {});
    mk(b2, 'user.instruction', 5, {
      text: 'Finish the orders currency migration — the backfill script and the model still need work.',
    });
    mk(b2, 'file.modified', 150, {
      files: [file(`${repoB}/api/orders/model.py`, 'update', 18, 6)],
      paths: [`${repoB}/api/orders/model.py`],
    });
    mk(b2, 'file.created', 120, {
      files: [file(`${repoB}/scripts/backfill_currency.py`, 'add', 72, 0)],
      paths: [`${repoB}/scripts/backfill_currency.py`],
    });
    mk(b2, 'test.run', 60, {
      command: 'pytest tests/test_orders.py',
      outcome: 'pass',
      exitCode: 0,
    });
    mk(b2, 'turn.completed', 5, { durationMs: 350_000 });
  }

  // --- 8. human-edited (ambiguous attribution) -------------------------------
  {
    const b: Builder = {
      session: 'demo-cc-humanedit',
      provider: 'claude-code',
      cwd: repoA,
      t: baseTs + 10 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'Tidy up the checkout validation and make the error messages consistent.',
    });
    mk(b, 'file.modified', 120, {
      files: [file(`${repoA}/src/checkout/validate.ts`, 'update', 44, 30)],
      paths: [`${repoA}/src/checkout/validate.ts`],
    });
    mk(b, 'file.modified', 90, {
      files: [file(`${repoA}/src/checkout/messages.ts`, 'update', 20, 14)],
      paths: [`${repoA}/src/checkout/messages.ts`],
    });
    mk(b, 'file.modified', 60, {
      files: [file(`${repoA}/src/checkout/validate.ts`, 'update', 8, 3)],
      paths: [`${repoA}/src/checkout/validate.ts`],
      reason: 'human-edit',
    });
    mk(b, 'typecheck.run', 30, { command: 'tsc --noEmit', outcome: 'pass', exitCode: 0 });
    mk(b, 'turn.completed', 5, { durationMs: 260_000 });
  }

  // --- 9/10. concurrent pair -------------------------------------------------
  {
    const start = baseTs + 11 * 3600_000;
    const a: Builder = {
      session: 'demo-cc-concurrent-a',
      provider: 'claude-code',
      cwd: repoA,
      t: start,
      events: all,
    };
    mk(a, 'session.started', 0, {});
    mk(a, 'user.instruction', 5, { text: 'Add server-side rendering for the marketing pages.' });
    mk(a, 'file.created', 100, {
      files: [file(`${repoA}/src/ssr/render.ts`, 'add', 96, 0)],
      paths: [`${repoA}/src/ssr/render.ts`],
    });
    mk(a, 'file.modified', 200, {
      files: [file(`${repoA}/src/server.ts`, 'update', 28, 6)],
      paths: [`${repoA}/src/server.ts`],
    });
    mk(a, 'build.run', 120, { command: 'npm run build', outcome: 'pass', exitCode: 0 });
    mk(a, 'turn.completed', 5, { durationMs: 430_000 });

    const bb: Builder = {
      session: 'demo-cx-concurrent-b',
      provider: 'codex',
      cwd: repoB,
      t: start + 90_000,
      events: all,
    };
    mk(bb, 'session.started', 0, {});
    mk(bb, 'user.instruction', 5, { text: 'Add rate limiting to the public API endpoints.' });
    mk(bb, 'file.created', 110, {
      files: [file(`${repoB}/api/middleware/ratelimit.py`, 'add', 88, 0)],
      paths: [`${repoB}/api/middleware/ratelimit.py`],
    });
    mk(bb, 'file.modified', 150, {
      files: [file(`${repoB}/api/app.py`, 'update', 14, 2)],
      paths: [`${repoB}/api/app.py`],
    });
    mk(bb, 'test.run', 90, {
      command: 'pytest tests/test_ratelimit.py',
      outcome: 'pass',
      exitCode: 0,
    });
    mk(bb, 'turn.completed', 5, { durationMs: 400_000 });
  }

  // --- 11. non-engineering conversation (must be excluded) -------------------
  {
    const b: Builder = {
      session: 'demo-cx-chat',
      provider: 'codex',
      cwd: '/demo/scratch',
      t: baseTs + 12 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'What should I make for dinner tonight? Something quick.',
    });
    mk(b, 'assistant.message', 20, { text: 'A few quick options…' });
    mk(b, 'user.instruction', 60, { text: 'Nice, thanks.' });
  }

  // --- 12. boilerplate-heavy scaffold ---------------------------------------
  {
    const b: Builder = {
      session: 'demo-cc-scaffold',
      provider: 'claude-code',
      cwd: repoA,
      t: baseTs + 13 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    mk(b, 'user.instruction', 5, {
      text: 'Scaffold CRUD endpoints for the eight admin resources.',
    });
    for (let i = 0; i < 8; i++) {
      mk(b, 'file.created', 25, {
        files: [file(`${repoA}/src/admin/resource_${i}.ts`, 'add', 320, 0)],
        paths: [`${repoA}/src/admin/resource_${i}.ts`],
      });
    }
    mk(b, 'file.created', 20, {
      files: [file(`${repoA}/package-lock.json`, 'update', 4200, 0, true)],
      paths: [`${repoA}/package-lock.json`],
    });
    mk(b, 'turn.completed', 10, { durationMs: 260_000 });
  }

  // --- 13. resumed session with replayed prefix ------------------------------
  {
    const b: Builder = {
      session: 'demo-cc-resumed',
      provider: 'claude-code',
      cwd: repoB,
      t: baseTs + 14 * 3600_000,
      events: all,
    };
    mk(b, 'session.started', 0, {});
    // Replayed history: identical work, flagged as replay. Must not be counted.
    mk(
      b,
      'user.instruction',
      5,
      { text: 'Add structured logging to the worker pool.' },
      { replay: true },
    );
    mk(
      b,
      'file.modified',
      30,
      {
        files: [file(`${repoB}/api/worker.py`, 'update', 60, 10)],
        paths: [`${repoB}/api/worker.py`],
      },
      { replay: true },
    );
    mk(b, 'session.compacted', 10, { reason: 'auto' });
    mk(b, 'user.instruction', 20, {
      text: 'Now add a log level setting so it can be turned down in production.',
    });
    mk(b, 'file.modified', 90, {
      files: [file(`${repoB}/api/worker.py`, 'update', 24, 4)],
      paths: [`${repoB}/api/worker.py`],
    });
    mk(b, 'file.modified', 60, {
      files: [file(`${repoB}/api/config.py`, 'update', 10, 2)],
      paths: [`${repoB}/api/config.py`],
    });
    mk(b, 'test.run', 40, { command: 'pytest tests/test_worker.py', outcome: 'pass', exitCode: 0 });
    mk(b, 'turn.completed', 5, { durationMs: 240_000 });
  }

  return withNarration(all).sort((a, b) => a.ts - b.ts);
}

/**
 * Real transcripts interleave assistant narration between tool calls, and that
 * narration is what a person reads — it is a primary input to the steering-time
 * model. A fixture without it would understate steering and therefore overstate
 * leverage, so the fixture includes it rather than being tuned around it.
 */
function withNarration(events: NormalizedEvent[]): NormalizedEvent[] {
  const bySession = new Map<string, NormalizedEvent[]>();
  for (const e of events) {
    const arr = bySession.get(e.sessionId);
    if (arr) arr.push(e);
    else bySession.set(e.sessionId, [e]);
  }
  const extra: NormalizedEvent[] = [];
  for (const [sessionId, list] of bySession) {
    const ordered = [...list].sort((a, b) => a.ts - b.ts);
    let sinceNarration = 0;
    for (let i = 0; i < ordered.length; i++) {
      const e = ordered[i] as NormalizedEvent;
      if (e.kind === 'assistant.message' || e.kind === 'user.instruction') {
        sinceNarration = 0;
        continue;
      }
      sinceNarration++;
      const next = ordered[i + 1];
      if (sinceNarration < 3 || !next) continue;
      // Only narrate when there is genuine room before the next event.
      const room = next.ts - e.ts;
      if (room < 30_000) continue;
      sinceNarration = 0;
      seq++;
      extra.push({
        id: hashId('demo-narr', sessionId, seq),
        sessionId,
        provider: e.provider,
        kind: 'assistant.message',
        ts: e.ts + Math.min(8_000, room / 4),
        ...(e.cwd ? { cwd: e.cwd } : {}),
        isSubagent: false,
        isReplay: e.isReplay,
        payload: { rawType: 'demo', text: 'Progress update from the agent.' },
        provenance: { ...e.provenance, lineIndex: seq },
      });
    }
  }
  return [...events, ...extra];
}

/**
 * Pick a base instant so the whole 14-hour scenario lands inside one local
 * calendar day and entirely in the past. Uses today when the day is far enough
 * along, otherwise yesterday.
 */
export function demoBaseInstant(now = Date.now()): number {
  const d = new Date(now);
  const todayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 8, 0, 0, 0).getTime();
  const spanMs = 14.5 * 3600_000;
  return todayStart + spanMs <= now ? todayStart : todayStart - DAY;
}

/** Insert the demo events into the database. Returns the number written. */
export function installDemoData(db: Db, baseTs?: number): number {
  const events = generateDemoEvents(baseTs ?? demoBaseInstant());
  const insert = db.handle.prepare(`
    INSERT OR IGNORE INTO events
      (id, session_id, provider, kind, ts, ts_raw, cwd, repo_id, turn_id,
       is_subagent, is_replay, payload, src_file, src_line, src_byte, parser, provider_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const insertRepo = db.handle.prepare(`
    INSERT INTO repos (repo_id, root, name, is_git, included, last_scanned)
    VALUES (?,?,?,0,1,?)
    ON CONFLICT(repo_id) DO NOTHING
  `);
  const insertSession = db.handle.prepare(`
    INSERT INTO sessions (session_id, provider, source_file, started_at, ended_at, cwd, repo_id, kind, event_count, user_instruction_count, title)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at = MIN(sessions.started_at, excluded.started_at),
      ended_at = MAX(sessions.ended_at, excluded.ended_at)
  `);

  const repoRoots = new Set(events.map((e) => e.cwd).filter((x): x is string => Boolean(x)));
  const repoIdOf = (root: string): string => hashId('repo', root);

  db.transaction(() => {
    for (const root of repoRoots) {
      insertRepo.run(repoIdOf(root), root, root.split('/').pop() ?? root, Date.now());
    }
    const sessionBounds = new Map<
      string,
      { min: number; max: number; n: number; instr: number; cwd: string; provider: string }
    >();
    for (const e of events) {
      const repoId = e.cwd ? repoIdOf(e.cwd) : null;
      insert.run(
        e.id,
        e.sessionId,
        e.provider,
        e.kind,
        e.ts,
        null,
        e.cwd ?? null,
        repoId,
        null,
        0,
        e.isReplay ? 1 : 0,
        JSON.stringify(e.payload),
        e.provenance.sourceFile,
        e.provenance.lineIndex,
        e.provenance.byteOffset,
        e.provenance.parser,
        'demo',
      );
      const b = sessionBounds.get(e.sessionId);
      const instr = e.kind === 'user.instruction' && !e.isReplay ? 1 : 0;
      if (b) {
        b.min = Math.min(b.min, e.ts);
        b.max = Math.max(b.max, e.ts);
        b.n++;
        b.instr += instr;
      } else {
        sessionBounds.set(e.sessionId, {
          min: e.ts,
          max: e.ts,
          n: 1,
          instr,
          cwd: e.cwd ?? '',
          provider: e.provider,
        });
      }
    }
    for (const [sid, b] of sessionBounds) {
      insertSession.run(
        sid,
        b.provider,
        `demo://${b.provider}/${sid}.jsonl`,
        b.min,
        b.max,
        b.cwd || null,
        b.cwd ? repoIdOf(b.cwd) : null,
        'primary',
        b.n,
        b.instr,
        `Demo session ${sid}`,
      );
    }
  });

  db.setConfig('demoInstalled', { at: Date.now(), events: events.length });
  return events.length;
}

export function isDemoInstalled(db: Db): boolean {
  return db.getConfig<{ at: number } | null>('demoInstalled', null) !== null;
}
