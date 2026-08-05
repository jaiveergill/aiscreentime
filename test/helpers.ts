import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Db } from '../src/store/db.ts';
import { DEFAULT_SETTINGS, type Settings } from '../src/core/config.ts';
import type { EventKind, EventPayload, NormalizedEvent, ProviderId } from '../src/core/types.ts';
import { hashId } from '../src/core/util.ts';

/** Disposable directory, removed by `cleanup`. */
export function tmpDir(prefix = 'screentime-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

export function tmpDb(): { db: Db; dir: string } {
  const dir = tmpDir('leverage-db-');
  return { db: new Db({ dir }), dir };
}

export function settings(patch: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, historyDays: 0, ...patch };
}

// ---------------------------------------------------------------------------
// Fixture writers — build provider files on disk with known content
// ---------------------------------------------------------------------------

export interface ClaudeFixtureOptions {
  readonly sessionId?: string;
  readonly cwd?: string;
  readonly version?: string;
  readonly branch?: string;
}

/** Write a Claude Code transcript with the given records. */
export function writeClaudeTranscript(
  home: string,
  records: Record<string, unknown>[],
  opts: ClaudeFixtureOptions = {},
): string {
  const sessionId = opts.sessionId ?? '11111111-2222-3333-4444-555555555555';
  const cwd = opts.cwd ?? '/tmp/fixture-repo';
  const slug = cwd.replace(/\//g, '-');
  const dir = path.join(home, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines = records.map((r) =>
    JSON.stringify({
      sessionId,
      cwd,
      version: opts.version ?? '2.1.220',
      gitBranch: opts.branch ?? 'main',
      isSidechain: false,
      userType: 'external',
      entrypoint: 'cli',
      ...r,
    }),
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

/**
 * Write a subagent transcript at `projects/<slug>/<session>/subagents/agent-<id>.jsonl`,
 * matching the layout Claude Code uses for delegated work.
 */
export function writeClaudeSubagent(
  home: string,
  records: Record<string, unknown>[],
  opts: { sessionId?: string; agentId?: string; cwd?: string; workflow?: string } = {},
): string {
  const sessionId = opts.sessionId ?? '11111111-2222-3333-4444-555555555555';
  const agentId = opts.agentId ?? 'a1b2c3d4e5f60718';
  const cwd = opts.cwd ?? '/tmp/fixture-repo';
  const slug = cwd.replace(/\//g, '-');
  const dir = opts.workflow
    ? path.join(home, 'projects', slug, sessionId, 'subagents', 'workflows', opts.workflow)
    : path.join(home, 'projects', slug, sessionId, 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `agent-${agentId}.jsonl`);
  const lines = records.map((r) =>
    JSON.stringify({
      sessionId,
      agentId,
      cwd,
      version: '2.1.220',
      isSidechain: true,
      parentUuid: null,
      userType: 'external',
      ...r,
    }),
  );
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

export function appendClaudeTranscript(file: string, records: Record<string, unknown>[]): void {
  const base = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0] as string) as Record<
    string,
    unknown
  >;
  const lines = records.map((r) =>
    JSON.stringify({
      sessionId: base['sessionId'],
      cwd: base['cwd'],
      version: base['version'],
      gitBranch: base['gitBranch'],
      isSidechain: false,
      ...r,
    }),
  );
  fs.appendFileSync(file, `${lines.join('\n')}\n`);
}

/** Convenience builders for Claude Code record shapes. */
export const cc = {
  user(text: string, ts: string, uuid: string): Record<string, unknown> {
    return { type: 'user', uuid, timestamp: ts, message: { role: 'user', content: text } };
  },
  assistant(text: string, ts: string, uuid: string): Record<string, unknown> {
    return {
      type: 'assistant',
      uuid,
      timestamp: ts,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'text', text }],
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
  },
  bash(command: string, ts: string, uuid: string, id = 'toolu_1'): Record<string, unknown> {
    return {
      type: 'assistant',
      uuid,
      timestamp: ts,
      message: {
        role: 'assistant',
        model: 'claude-opus-5',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
    };
  },
  bashResult(stdout: string, ts: string, uuid: string, id = 'toolu_1'): Record<string, unknown> {
    return {
      type: 'user',
      uuid,
      timestamp: ts,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: id, content: stdout }],
      },
      toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false },
    };
  },
  edit(
    filePath: string,
    ts: string,
    uuid: string,
    added: number,
    removed: number,
  ): Record<string, unknown> {
    const lines: string[] = [];
    for (let i = 0; i < added; i++) lines.push(`+new line ${i}`);
    for (let i = 0; i < removed; i++) lines.push(`-old line ${i}`);
    return {
      type: 'user',
      uuid,
      timestamp: ts,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_edit', content: 'ok' }],
      },
      toolUseResult: {
        type: 'update',
        filePath,
        structuredPatch: [{ oldStart: 1, oldLines: removed, newStart: 1, newLines: added, lines }],
        originalFile: 'x',
        userModified: false,
      },
    };
  },
  turnDuration(ms: number, ts: string, uuid: string): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'turn_duration',
      durationMs: ms,
      timestamp: ts,
      uuid,
      messageCount: 4,
    };
  },
  compactBoundary(ts: string, uuid: string): Record<string, unknown> {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      timestamp: ts,
      uuid,
      parentUuid: null,
      logicalParentUuid: 'prev',
      isCompactSummary: true,
      compactMetadata: {
        trigger: 'auto',
        preTokens: 100000,
        postTokens: 2000,
        cumulativeDroppedTokens: 98000,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Codex fixtures
// ---------------------------------------------------------------------------

export function writeCodexRollout(
  home: string,
  records: Record<string, unknown>[],
  opts: { sessionId?: string; date?: string; cwd?: string; cliVersion?: string } = {},
): string {
  const sessionId = opts.sessionId ?? '019e0000-0000-7000-8000-000000000001';
  const date = opts.date ?? '2026-05-12';
  const [y, m, d] = date.split('-');
  const dir = path.join(home, 'sessions', y as string, m as string, d as string);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${date}T09-00-00-${sessionId}.jsonl`);
  const meta = {
    timestamp: `${date}T09:00:00.000Z`,
    type: 'session_meta',
    payload: {
      session_id: sessionId,
      id: sessionId,
      timestamp: `${date}T09:00:00.000Z`,
      cwd: opts.cwd ?? '/tmp/fixture-repo',
      originator: 'codex_vscode',
      cli_version: opts.cliVersion ?? '0.146.0-alpha.9.2',
      source: 'vscode',
      model_provider: 'openai',
    },
  };
  const lines = [JSON.stringify(meta), ...records.map((r) => JSON.stringify(r))];
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

export const cx = {
  userMessage(text: string, ts: string): Record<string, unknown> {
    return { timestamp: ts, type: 'event_msg', payload: { type: 'user_message', message: text } };
  },
  agentMessage(text: string, ts: string): Record<string, unknown> {
    return { timestamp: ts, type: 'event_msg', payload: { type: 'agent_message', message: text } };
  },
  execEnd(command: string, exitCode: number, ts: string, callId: string): Record<string, unknown> {
    return {
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'exec_command_end',
        call_id: callId,
        command: ['/bin/zsh', '-lc', command],
        cwd: '/tmp/fixture-repo',
        exit_code: exitCode,
        aggregated_output: exitCode === 0 ? 'ok' : 'boom',
        duration: { secs: 1, nanos: 0 },
        status: 'completed',
      },
    };
  },
  /** Older-style function_call with no event_msg counterpart. */
  execCall(command: string, ts: string, callId: string): Record<string, unknown> {
    return {
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: callId,
        arguments: JSON.stringify({ cmd: command, workdir: '/tmp/fixture-repo' }),
      },
    };
  },
  execOutput(exitCode: number, body: string, ts: string, callId: string): Record<string, unknown> {
    return {
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: callId,
        output: `Chunk ID: abc123\nWall time: 0.4210 seconds\nProcess exited with code ${exitCode}\nOriginal token count: 10\nOutput:\n${body}`,
      },
    };
  },
  patchApplyEnd(
    filePath: string,
    kind: 'add' | 'update',
    diff: string,
    ts: string,
    callId: string,
  ): Record<string, unknown> {
    return {
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'patch_apply_end',
        call_id: callId,
        success: true,
        status: 'completed',
        changes: { [filePath]: { type: kind, unified_diff: diff } },
      },
    };
  },
  applyPatchCall(patchText: string, ts: string, callId: string): Record<string, unknown> {
    return {
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'apply_patch',
        call_id: callId,
        arguments: JSON.stringify({ input: patchText }),
      },
    };
  },
  taskComplete(durationMs: number, ts: string, turnId: string): Record<string, unknown> {
    return {
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'task_complete',
        turn_id: turnId,
        last_agent_message: 'done',
        duration_ms: durationMs,
        completed_at: Math.floor(Date.parse(ts) / 1000),
      },
    };
  },
  turnAborted(ts: string, turnId: string): Record<string, unknown> {
    return {
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'turn_aborted',
        turn_id: turnId,
        reason: 'interrupted',
        duration_ms: 4000,
        completed_at: Math.floor(Date.parse(ts) / 1000),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// In-memory normalized events, for unit tests that skip the parsers
// ---------------------------------------------------------------------------

let evSeq = 0;

export function ev(
  kind: EventKind,
  ts: number,
  payload: EventPayload = {},
  opts: {
    sessionId?: string;
    provider?: ProviderId;
    repoId?: string;
    cwd?: string;
    isReplay?: boolean;
  } = {},
): NormalizedEvent {
  evSeq++;
  return {
    id: hashId('test', evSeq, kind, ts),
    sessionId: opts.sessionId ?? 's1',
    provider: opts.provider ?? 'claude-code',
    kind,
    ts,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.repoId ? { repoId: opts.repoId } : {}),
    isSubagent: false,
    isReplay: opts.isReplay ?? false,
    payload,
    provenance: {
      provider: opts.provider ?? 'claude-code',
      sourceFile: '/test/fixture.jsonl',
      lineIndex: evSeq,
      byteOffset: evSeq * 100,
      parser: 'test/v1',
    },
  };
}

export function fileChange(
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

export const T0 = Date.UTC(2026, 4, 12, 9, 0, 0);
export const MIN = 60_000;
