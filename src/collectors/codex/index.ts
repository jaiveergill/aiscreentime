import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import type {
  EventKind,
  EventPayload,
  FileChange,
  NormalizedEvent,
  ProviderId,
} from '../../core/types.ts';
import {
  asArray,
  asNumber,
  asString,
  capText,
  hashId,
  isRecord,
  parseTs,
  safeJsonParse,
} from '../../core/util.ts';
import { redact } from '../../privacy/redact.ts';
import { classifyCommand, classifyOutcome } from '../../normalize/commands.ts';
import { isGeneratedPath, isBinaryPath } from '../../normalize/paths.ts';
import { scanJsonl } from '../jsonl.ts';
import {
  HealthAccumulator,
  type Collector,
  type ParseContext,
  type ParseResult,
  type ProviderDetection,
  type SessionSeed,
  type SourceFile,
} from '../types.ts';

const PROVIDER: ProviderId = 'codex';
const PARSER = 'codex/rollout-v1';

/**
 * Codex writes one "rollout" JSONL per thread under
 * `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<iso>-<uuid>.jsonl`.
 *
 * Verified against rollouts written by CLI versions 0.108 – 0.146.
 * Envelope: `{ timestamp, type, payload }` where `type` is one of
 *   session_meta | response_item | event_msg | turn_context | compacted |
 *   world_state | inter_agent_communication_metadata
 *
 * `event_msg` payloads carry the *measured* facts we care about most:
 * `task_complete.duration_ms`, `exec_command_end.exit_code/duration`, and
 * `patch_apply_end.changes`. `response_item` payloads carry the model-side
 * view of the same turns, so we take timings from `event_msg` and structure
 * from `response_item` and deduplicate between them by call id.
 */
export class CodexCollector implements Collector {
  readonly id = PROVIDER;
  readonly displayName = 'Codex';

  private readonly home: string;

  constructor(home?: string) {
    this.home = home ?? process.env.CODEX_HOME ?? path.join(homedir(), '.codex');
  }

  dataDirs(): string[] {
    return [path.join(this.home, 'sessions')];
  }

  async detect(): Promise<ProviderDetection> {
    const dirs = this.dataDirs();
    const found = dirs.filter((d) => fs.existsSync(d));
    const files = await this.discover();
    let totalBytes = 0;
    let earliest: number | undefined;
    let latest: number | undefined;
    for (const f of files) {
      totalBytes += f.size;
      if (earliest === undefined || f.mtimeMs < earliest) earliest = f.mtimeMs;
      if (latest === undefined || f.mtimeMs > latest) latest = f.mtimeMs;
    }
    const versions = new Set<string>();
    for (const f of files.slice(-8)) {
      const v = peekCliVersion(f.path);
      if (v) versions.add(v);
    }
    const notes: string[] = [];
    if (found.length === 0) {
      notes.push(
        'No Codex sessions directory found. Set CODEX_HOME if Codex stores its data in a non-default location.',
      );
    }
    const indexPath = path.join(this.home, 'session_index.jsonl');
    if (fs.existsSync(indexPath)) {
      notes.push('Found session_index.jsonl — thread titles will be used where available.');
    }
    return {
      provider: PROVIDER,
      displayName: this.displayName,
      installed: found.length > 0 && files.length > 0,
      dataDirs: dirs,
      foundDirs: found,
      sessionFileCount: files.length,
      totalBytes,
      ...(earliest !== undefined ? { earliest } : {}),
      ...(latest !== undefined ? { latest } : {}),
      versionsSeen: [...versions].sort().reverse(),
      notes,
    };
  }

  /** Thread id → human title, read from Codex's own session index when present. */
  readThreadNames(): Map<string, string> {
    const out = new Map<string, string>();
    const p = path.join(this.home, 'session_index.jsonl');
    if (!fs.existsSync(p)) return out;
    try {
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const o = safeJsonParse(line);
        if (!isRecord(o)) continue;
        const id = asString(o['id']);
        const name = asString(o['thread_name']);
        if (id && name) out.set(id, name);
      }
    } catch {
      /* index is optional */
    }
    return out;
  }

  async discover(): Promise<SourceFile[]> {
    const root = path.join(this.home, 'sessions');
    if (!fs.existsSync(root)) return [];
    const out: SourceFile[] = [];
    // Layout is sessions/YYYY/MM/DD/*.jsonl; walk defensively in case it changes.
    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const st = fs.statSync(full);
            const m = /rollout-[\dT-]+-([0-9a-f-]{36})\.jsonl$/.exec(e.name);
            out.push({
              provider: PROVIDER,
              path: full,
              size: st.size,
              mtimeMs: st.mtimeMs,
              ...(m?.[1] ? { sessionHint: m[1] } : {}),
            });
          } catch {
            /* skip */
          }
        }
      }
    };
    walk(root, 0);
    out.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return out;
  }

  async parse(file: SourceFile, ctx: ParseContext): Promise<ParseResult> {
    const h = new HealthAccumulator(PROVIDER, PARSER);
    h.filesSeen = 1;
    const events: NormalizedEvent[] = [];
    const seeds = new Map<string, SessionSeed>();
    const threadNames = this.threadNamesCache ?? (this.threadNamesCache = this.readThreadNames());

    let sessionId = file.sessionHint ?? 'unknown';
    let cwd: string | undefined;
    let cliVersion: string | undefined;
    let model: string | undefined;
    /** Call ids already emitted, so response_item and event_msg do not double-count. */
    const seenCallIds = new Set<string>();
    /** After a `compacted` record, replayed history must not be re-counted. */
    let inReplay = false;

    /**
     * Reconciliation state.
     *
     * Codex changed how it records shell execution between versions: newer
     * builds emit a rich `event_msg/exec_command_end` (exit code, duration,
     * parsed command), older ones emit only `response_item/function_call` plus
     * a `function_call_output` whose text embeds "Process exited with code N".
     *
     * We parse *both* and reconcile by `call_id` at end of file: the event_msg
     * form always wins, and the response_item form is dropped. That way neither
     * version loses data and no version double-counts.
     */
    const rc: ReconcileCtx = {
      eventMsgCalls: new Set<string>(),
      fallbackIndexByCall: new Map<string, number>(),
      mutablePayloads: new Map<number, Record<string, unknown>>(),
    };

    const redactOpts = { mode: ctx.redactMode, customTerms: ctx.customRedactTerms } as const;
    const rd = (s: string | undefined, cap = 2000): string | undefined => {
      if (!s) return undefined;
      return capText(redact(s, redactOpts).text, cap);
    };

    const scan = await scanJsonl(
      file.path,
      ctx.fromByte,
      ctx.fromLine,
      (line) => {
        h.linesRead++;
        const parsed = safeJsonParse(line.raw);
        if (!isRecord(parsed)) {
          h.recordsMalformed++;
          return;
        }
        const rec = parsed;
        const envType = asString(rec['type']) ?? '';
        const ts = parseTs(rec['timestamp']);
        const payload = isRecord(rec['payload']) ? rec['payload'] : undefined;
        if (!payload) {
          h.unknown(`${envType}:<no payload>`);
          h.recordsIgnored++;
          return;
        }

        const prov = {
          provider: PROVIDER,
          sourceFile: file.path,
          lineIndex: line.lineIndex,
          byteOffset: line.byteOffset,
          parser: PARSER,
          ...(cliVersion ? { providerVersion: cliVersion } : {}),
        };

        const push = (
          kind: EventKind,
          at: number | undefined,
          p: EventPayload,
          callId?: string,
        ): number => {
          const when = at ?? ts;
          if (when === undefined) {
            h.recordsIgnored++;
            return -1;
          }
          if (callId) {
            if (seenCallIds.has(`${kind}:${callId}`)) {
              h.recordsDuplicate++;
              return -1;
            }
            seenCallIds.add(`${kind}:${callId}`);
          }
          // Codex writes every `token_count` event twice, a fraction of a
          // second apart and byte-identical — measured at 231 duplicate pairs
          // out of 462 records in one session, i.e. exactly half. Keying usage
          // on the session's running cumulative total instead of the file line
          // collapses each pair, because that total is monotonic and so
          // identifies the turn regardless of how many times it is written.
          // Scoped to the transcript: the running total is only monotonic
          // within a session, and two sessions can share an early value.
          // Codex's duplicates are adjacent lines in one file, so file-scoping
          // still collapses every one of them.
          const id =
            kind === 'tokens.reported' && p.requestId
              ? hashId(PROVIDER, 'usage', file.path, p.requestId)
              : hashId(PROVIDER, file.path, line.lineIndex, kind, callId ?? '', p.rawType ?? '');
          if (ctx.seen.has(id)) {
            h.recordsDuplicate++;
            return -1;
          }
          ctx.seen.add(id);
          const mutable = { ...p } as Record<string, unknown>;
          const idx = events.length;
          events.push({
            id,
            sessionId,
            provider: PROVIDER,
            kind,
            ts: when,
            ...(asString(rec['timestamp']) ? { tsRaw: asString(rec['timestamp']) as string } : {}),
            ...(cwd ? { cwd } : {}),
            ...(asString(payload['turn_id'])
              ? { turnId: asString(payload['turn_id']) as string }
              : {}),
            isSubagent: false,
            isReplay: inReplay,
            payload: mutable as EventPayload,
            provenance: prov,
          });
          rc.mutablePayloads.set(idx, mutable);
          h.eventsEmitted++;
          if (inReplay) h.recordsReplay++;
          return idx;
        };

        switch (envType) {
          case 'session_meta': {
            sessionId = asString(payload['session_id']) ?? asString(payload['id']) ?? sessionId;
            cwd = asString(payload['cwd']) ?? cwd;
            cliVersion = asString(payload['cli_version']);
            h.version(cliVersion);
            const git = isRecord(payload['git']) ? payload['git'] : undefined;
            const forkedFrom = asString(payload['forked_from_id']);
            const parentThread = asString(payload['parent_thread_id']);
            const nickname = asString(payload['agent_nickname']);
            const title = threadNames.get(sessionId);
            seeds.set(sessionId, {
              sessionId,
              provider: PROVIDER,
              sourceFile: file.path,
              kind: forkedFrom ? 'fork' : parentThread ? 'subagent' : 'primary',
              ...(cwd ? { cwd } : {}),
              ...(cliVersion ? { providerVersion: cliVersion } : {}),
              ...((forkedFrom ?? parentThread)
                ? { parentSessionId: (forkedFrom ?? parentThread) as string }
                : {}),
              ...(title
                ? { title: rd(title, 200) as string }
                : nickname
                  ? { title: rd(nickname, 200) as string }
                  : {}),
              ...(git && asString(git['branch'])
                ? { branch: asString(git['branch']) as string }
                : {}),
              ...(git && asString(git['repository_url'])
                ? { repositoryUrl: asString(git['repository_url']) as string }
                : {}),
              ...(git && asString(git['commit_hash'])
                ? { commitHash: asString(git['commit_hash']) as string }
                : {}),
            });
            push('session.started', ts, {
              rawType: 'session_meta',
              ...(git && asString(git['branch'])
                ? { branch: asString(git['branch']) as string }
                : {}),
              ...(git && asString(git['commit_hash'])
                ? { commitHash: asString(git['commit_hash']) as string }
                : {}),
            });
            if (git) {
              push('git.observed', ts, {
                rawType: 'session_meta.git',
                ...(asString(git['branch']) ? { branch: asString(git['branch']) as string } : {}),
                ...(asString(git['commit_hash'])
                  ? { commitHash: asString(git['commit_hash']) as string }
                  : {}),
              });
            }
            if (forkedFrom)
              push('session.forked', ts, { rawType: 'forked_from_id', reason: forkedFrom });
            break;
          }

          case 'turn_context': {
            cwd = asString(payload['cwd']) ?? cwd;
            const m = asString(payload['model']);
            if (m) model = m;
            const seed = seeds.get(sessionId);
            if (seed && m && !seed.model) seeds.set(sessionId, { ...seed, model: m });
            h.recordsIgnored++;
            break;
          }

          case 'compacted': {
            push('session.compacted', ts, { rawType: 'compacted', reason: 'context-window' });
            // Everything replayed inside `replacement_history` is prior history.
            // We never re-parse it: the original records are already ingested.
            inReplay = false;
            h.recordsIgnored++;
            break;
          }

          case 'event_msg':
            handleEventMsg(payload, push, rd, h, model, rc);
            break;

          case 'response_item':
            handleResponseItem(payload, push, rd, h, rc, cwd);
            break;

          case 'world_state':
          case 'inter_agent_communication_metadata':
            h.recordsIgnored++;
            break;

          default:
            h.unknown(envType || '<missing type>');
            h.recordsIgnored++;
        }
      },
      ctx.signal,
    );

    h.bytesRead = scan.bytesConsumed - ctx.fromByte;

    // Reconcile: drop response_item-derived exec/patch events whose call_id was
    // also covered by a richer event_msg record.
    let finalEvents = events;
    if (rc.eventMsgCalls.size > 0 && rc.fallbackIndexByCall.size > 0) {
      const drop = new Set<number>();
      for (const [callId, idx] of rc.fallbackIndexByCall) {
        if (rc.eventMsgCalls.has(callId)) {
          drop.add(idx);
          h.recordsDuplicate++;
          h.eventsEmitted--;
        }
      }
      if (drop.size > 0) finalEvents = events.filter((_, i) => !drop.has(i));
    }

    if (seeds.size === 0 && sessionId !== 'unknown') {
      seeds.set(sessionId, {
        sessionId,
        provider: PROVIDER,
        sourceFile: file.path,
        kind: 'primary',
        ...(cwd ? { cwd } : {}),
      });
    }

    return {
      events: finalEvents,
      bytesConsumed: scan.bytesConsumed,
      linesConsumed: scan.linesConsumed,
      health: h.freeze(),
      sessions: [...seeds.values()],
    };
  }

  private threadNamesCache: Map<string, string> | undefined;
}

type PushFn = (kind: EventKind, at: number | undefined, p: EventPayload, callId?: string) => number;
type RedactFn = (s: string | undefined, cap?: number) => string | undefined;

interface ReconcileCtx {
  /** call_ids for which a rich `event_msg` record exists. */
  readonly eventMsgCalls: Set<string>;
  /** call_id → index of the response_item-derived fallback event. */
  readonly fallbackIndexByCall: Map<string, number>;
  /** Event index → its mutable payload, so outputs can enrich earlier calls. */
  readonly mutablePayloads: Map<number, Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// event_msg — the measured side
// ---------------------------------------------------------------------------

function handleEventMsg(
  p: Record<string, unknown>,
  push: PushFn,
  rd: RedactFn,
  h: HealthAccumulator,
  model: string | undefined,
  rc: ReconcileCtx,
): void {
  const t = asString(p['type']) ?? '';
  switch (t) {
    case 'user_message': {
      const cleaned = extractUserRequest(asString(p['message']) ?? '');
      if (cleaned.length === 0) {
        // The message was entirely synthetic context with no human request in
        // it. Counting it would create a task titled after Codex's own
        // scaffolding.
        h.recordsIgnored++;
        return;
      }
      push('user.instruction', undefined, { rawType: t, text: rd(cleaned, 4000) });
      break;
    }
    case 'agent_message':
      push('assistant.message', undefined, {
        rawType: t,
        text: rd(asString(p['message']), 3000),
        ...(model ? { model } : {}),
      });
      break;

    case 'agent_reasoning':
    case 'agent_reasoning_delta':
    case 'agent_reasoning_section_break': {
      // Reasoning length is recorded; the content itself is not stored.
      const len = (asString(p['text']) ?? asString(p['delta']) ?? '').length;
      push('assistant.reasoning', undefined, {
        rawType: t,
        text: `[${len} chars of reasoning]`,
      });
      break;
    }

    case 'task_started':
      push('turn.completed', parseSecs(p['started_at']), { rawType: t, reason: 'started' });
      break;

    case 'task_complete': {
      const dur = asNumber(p['duration_ms']);
      const completedAt = parseSecs(p['completed_at']);
      push(
        'turn.completed',
        completedAt,
        {
          rawType: t,
          ...(dur !== undefined ? { durationMs: dur } : {}),
          text: rd(asString(p['last_agent_message']), 1500),
        },
        asString(p['turn_id']),
      );
      break;
    }

    case 'turn_aborted': {
      const dur = asNumber(p['duration_ms']);
      push('user.interrupt', parseSecs(p['completed_at']), {
        rawType: t,
        reason: asString(p['reason']) ?? 'aborted',
        ...(dur !== undefined ? { durationMs: dur } : {}),
      });
      break;
    }

    case 'exec_command_end': {
      const cid = asString(p['call_id']);
      if (cid) rc.eventMsgCalls.add(cid);
      const command = parseCmdArray(p['command']) ?? asString(p['command']) ?? '';
      const exit = asNumber(p['exit_code']);
      const stdout = asString(p['aggregated_output']) ?? asString(p['stdout']) ?? '';
      const stderr = asString(p['stderr']) ?? '';
      const durationMs = parseDuration(p['duration']);
      const info = classifyCommand(command);
      const outcome = classifyOutcome(exit, stdout, stderr);
      const kind: EventKind =
        info.cls === 'test'
          ? 'test.run'
          : info.cls === 'build'
            ? 'build.run'
            : info.cls === 'lint'
              ? 'lint.run'
              : info.cls === 'typecheck'
                ? 'typecheck.run'
                : 'shell.command';
      push(
        kind,
        undefined,
        {
          rawType: t,
          command: rd(command, 1000),
          ...(exit !== undefined ? { exitCode: exit } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          outcome,
          text: rd(stdout || stderr, 800),
        },
        asString(p['call_id']),
      );
      if (outcome === 'fail') {
        push('error.encountered', undefined, { rawType: t, text: rd(stderr || stdout, 600) });
      }
      break;
    }

    case 'patch_apply_end': {
      const cid = asString(p['call_id']);
      if (cid) rc.eventMsgCalls.add(cid);
      const changes = isRecord(p['changes']) ? p['changes'] : {};
      const files: FileChange[] = [];
      for (const [fp, val] of Object.entries(changes)) {
        if (!isRecord(val)) continue;
        const kind = asString(val['type']) ?? 'update';
        const content = asString(val['content']) ?? '';
        const diff = asString(val['unified_diff']) ?? '';
        let added = 0;
        let removed = 0;
        if (diff) {
          for (const l of diff.split('\n')) {
            if (l.startsWith('+') && !l.startsWith('+++')) added++;
            else if (l.startsWith('-') && !l.startsWith('---')) removed++;
          }
        } else if (content) {
          added = content.split('\n').length;
        }
        files.push({
          path: fp,
          changeType: kind === 'add' ? 'add' : kind === 'delete' ? 'delete' : 'update',
          linesAdded: added,
          linesRemoved: removed,
          generated: isGeneratedPath(fp),
          binary: isBinaryPath(fp),
        });
      }
      if (files.length === 0) {
        h.recordsIgnored++;
        return;
      }
      const success = p['success'] === true || asString(p['status']) === 'completed';
      const anyAdd = files.some((f) => f.changeType === 'add');
      const anyDel = files.every((f) => f.changeType === 'delete');
      push(
        anyDel ? 'file.deleted' : anyAdd ? 'file.created' : 'file.modified',
        undefined,
        {
          rawType: t,
          files,
          paths: files.map((f) => f.path),
          outcome: success ? 'pass' : 'fail',
        },
        asString(p['call_id']),
      );
      break;
    }

    case 'mcp_tool_call_end':
      push(
        'tool.invoked',
        undefined,
        {
          rawType: t,
          toolName: asString(p['tool']) ?? 'mcp',
        },
        asString(p['call_id']),
      );
      break;

    case 'web_search_end':
      push('search.performed', undefined, { rawType: t, text: rd(asString(p['query']), 200) });
      break;

    case 'token_count': {
      const info = isRecord(p['info']) ? p['info'] : undefined;
      const last =
        info && isRecord(info['last_token_usage']) ? info['last_token_usage'] : undefined;
      if (!last) {
        h.recordsIgnored++;
        return;
      }
      // `last_token_usage` is the delta for this turn; `total_token_usage` is
      // the running session total. Summing the latter would multiply-count.
      // Codex reports `input_tokens` already inclusive of `cached_input_tokens`
      // (input + output == total_tokens), so unlike Claude it needs no
      // adjustment — the cached figure is a breakdown, not an addend.
      // `reasoning_output_tokens` is likewise already inside `output_tokens`,
      // verified across 30,263 records with reasoning > 0 and no counterexample
      // — so unlike Claude, Codex output is complete rather than a floor.
      //
      // The cumulative total doubles as this turn's identity for deduplication;
      // it rises monotonically, so the pair of identical records Codex writes
      // for one turn share it and collapse.
      const total = info && isRecord(info['total_token_usage']) ? info['total_token_usage'] : {};
      const turnKey = `${asNumber(total['input_tokens']) ?? 0}:${asNumber(total['output_tokens']) ?? 0}:${asNumber(total['total_tokens']) ?? 0}`;
      push('tokens.reported', undefined, {
        rawType: t,
        requestId: turnKey,
        tokensIn: asNumber(last['input_tokens']) ?? 0,
        tokensOut: asNumber(last['output_tokens']) ?? 0,
        tokensCacheRead: asNumber(last['cached_input_tokens']) ?? 0,
      });
      break;
    }

    case 'collab_agent_spawn_end':
      push(
        'subagent.spawned',
        undefined,
        {
          rawType: t,
          ...(asString(p['new_thread_id'])
            ? { subagentId: asString(p['new_thread_id']) as string }
            : {}),
          subagentLabel: rd(asString(p['new_agent_nickname']) ?? asString(p['prompt']), 120),
        },
        asString(p['call_id']),
      );
      break;

    case 'sub_agent_activity':
      push(
        'subagent.completed',
        parseMs(p['occurred_at_ms']),
        {
          rawType: t,
          ...(asString(p['agent_thread_id'])
            ? { subagentId: asString(p['agent_thread_id']) as string }
            : {}),
          reason: asString(p['kind']) ?? 'activity',
        },
        asString(p['event_id']),
      );
      break;

    case 'error': {
      // Provider-side failures (rate limits, transport). Real friction the
      // person absorbed, but never evidence that the task itself was hard.
      push('error.encountered', undefined, {
        rawType: t,
        text: rd(asString(p['message']), 300),
        reason: asString(p['codex_error_info']) ?? 'provider-error',
      });
      break;
    }

    case 'collab_close_end':
      push(
        'subagent.completed',
        undefined,
        {
          rawType: t,
          ...(asString(p['receiver_thread_id'])
            ? { subagentId: asString(p['receiver_thread_id']) as string }
            : {}),
          subagentLabel: rd(asString(p['receiver_agent_nickname']), 80),
        },
        asString(p['call_id']),
      );
      break;

    case 'context_compacted':
      push('session.compacted', undefined, { rawType: t, reason: 'auto' });
      break;

    case 'thread_rolled_back':
      push('agent.retry', undefined, { rawType: t, reason: 'rollback' });
      break;

    case 'collab_waiting_end':
    case 'item_completed':
    case 'thread_settings_applied':
    case 'thread_name_updated':
    case 'thread_goal_updated':
    case 'image_generation_end':
      h.recordsIgnored++;
      break;

    default:
      h.unknown(`event_msg:${t}`);
      h.recordsIgnored++;
  }
}

// ---------------------------------------------------------------------------
// response_item — the model-side view
// ---------------------------------------------------------------------------

function handleResponseItem(
  p: Record<string, unknown>,
  push: PushFn,
  rd: RedactFn,
  h: HealthAccumulator,
  rc: ReconcileCtx,
  cwd: string | undefined,
): void {
  const t = asString(p['type']) ?? '';
  switch (t) {
    case 'message': {
      const role = asString(p['role']);
      // `developer` and `system` roles are harness instructions, not human input.
      if (role !== 'user') {
        h.recordsIgnored++;
        return;
      }
      let text = '';
      for (const c of asArray(p['content'])) {
        if (isRecord(c) && (c['type'] === 'input_text' || c['type'] === 'text')) {
          text += `${asString(c['text']) ?? ''}\n`;
        }
      }
      // Same envelope as `event_msg/user_message` — this is simply the
      // model-side view of it, and it must be unwrapped identically.
      text = extractUserRequest(text.trim());
      if (!text) {
        h.recordsIgnored++;
        return;
      }
      push(
        'user.instruction',
        undefined,
        { rawType: `response_item:${t}`, text: rd(text, 4000) },
        asString(p['id']),
      );
      break;
    }
    case 'reasoning': {
      let len = 0;
      for (const s of asArray(p['summary'])) {
        if (isRecord(s)) len += (asString(s['text']) ?? '').length;
      }
      push(
        'assistant.reasoning',
        undefined,
        {
          rawType: `response_item:${t}`,
          text: `[${len} chars of reasoning]`,
        },
        asString(p['id']),
      );
      break;
    }
    case 'function_call':
    case 'custom_tool_call': {
      const name = asString(p['name']) ?? 'unknown';
      const callId = asString(p['call_id']) ?? asString(p['id']);
      const args = parseArgs(p['arguments'] ?? p['input']);

      // Shell execution. On versions that also emit `exec_command_end` this
      // event is dropped during reconciliation; on versions that do not, it is
      // the only record of the command and must be kept.
      if (name === 'exec_command' || name === 'exec' || name === 'shell' || name === 'run') {
        const command =
          asString(args['cmd']) ?? asString(args['command']) ?? joinCmd(args['command']);
        const info = classifyCommand(command);
        const kind: EventKind =
          info.cls === 'test'
            ? 'test.run'
            : info.cls === 'build'
              ? 'build.run'
              : info.cls === 'lint'
                ? 'lint.run'
                : info.cls === 'typecheck'
                  ? 'typecheck.run'
                  : 'shell.command';
        const idx = push(
          kind,
          undefined,
          { rawType: `response_item:${t}`, toolName: name, command: rd(command, 1000) },
          callId ? `ri:${callId}` : undefined,
        );
        if (idx >= 0 && callId) rc.fallbackIndexByCall.set(callId, idx);
        return;
      }

      if (name === 'apply_patch') {
        const patchText = asString(args['input']) ?? asString(args['patch']) ?? '';
        const files = parseApplyPatch(patchText, cwd);
        if (files.length === 0) {
          h.recordsIgnored++;
          return;
        }
        const anyAdd = files.some((f) => f.changeType === 'add');
        const allDel = files.every((f) => f.changeType === 'delete');
        const idx = push(
          allDel ? 'file.deleted' : anyAdd ? 'file.created' : 'file.modified',
          undefined,
          {
            rawType: `response_item:${t}`,
            toolName: name,
            files,
            paths: files.map((f) => f.path),
          },
          callId ? `ri:${callId}` : undefined,
        );
        if (idx >= 0 && callId) rc.fallbackIndexByCall.set(callId, idx);
        return;
      }

      const kind: EventKind =
        name === 'spawn_agent'
          ? 'subagent.spawned'
          : name === 'update_plan'
            ? 'assistant.reasoning'
            : name === 'request_user_input'
              ? 'approval.requested'
              : 'tool.invoked';
      push(kind, undefined, { rawType: `response_item:${t}`, toolName: name }, callId);
      break;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = asString(p['call_id']);
      const out = p['output'];
      const text =
        typeof out === 'string' ? out : isRecord(out) ? asString(out['content']) : undefined;

      // Older Codex builds embed the exit code and wall time in the output
      // preamble. Parse it and backfill the originating exec event.
      const meta = parseExecPreamble(text);
      if (callId && meta) {
        const idx = rc.fallbackIndexByCall.get(callId);
        if (idx !== undefined) {
          const target = rc.mutablePayloads.get(idx);
          if (target) {
            if (meta.exitCode !== undefined) target['exitCode'] = meta.exitCode;
            if (meta.durationMs !== undefined) target['durationMs'] = meta.durationMs;
            target['outcome'] = classifyOutcome(meta.exitCode, meta.body, undefined);
          }
        }
      }
      push(
        'tool.result',
        undefined,
        {
          rawType: `response_item:${t}`,
          text: rd(meta?.body ?? text, 600),
          ...(meta?.exitCode !== undefined ? { exitCode: meta.exitCode } : {}),
          ...(meta ? { outcome: classifyOutcome(meta.exitCode, meta.body, undefined) } : {}),
        },
        callId,
      );
      if (meta && meta.exitCode !== undefined && meta.exitCode !== 0) {
        push('error.encountered', undefined, {
          rawType: `response_item:${t}`,
          text: rd(meta.body, 400),
        });
      }
      break;
    }
    case 'web_search_call':
      push('search.performed', undefined, { rawType: `response_item:${t}` }, asString(p['id']));
      break;
    case 'agent_message':
      push(
        'assistant.message',
        undefined,
        {
          rawType: `response_item:${t}`,
          text: rd(asString(p['message']), 2000),
        },
        asString(p['id']),
      );
      break;
    case 'tool_search_call':
    case 'tool_search_output':
      h.recordsIgnored++;
      break;
    default:
      h.unknown(`response_item:${t}`);
      h.recordsIgnored++;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pull the human's actual request out of a Codex user message.
 *
 * Codex wraps instructions in a structured envelope that can carry attached
 * files, browser tab context, and available-plugin listings:
 *
 *     # Files mentioned by the user:
 *     ...
 *     # Chrome tabs:
 *     ...
 *     ## My request for Codex:
 *     <the actual request>
 *
 * Taking the message verbatim produces tasks titled "Chrome tabs: The user has
 * the Chrome extension side panel open", repeated once per turn. When the
 * explicit marker is present the tail after it is authoritative; otherwise we
 * drop known synthetic sections and keep whatever prose remains.
 */
const REQUEST_MARKER = /^##\s*My request for Codex:\s*$/m;
const SYNTHETIC_SECTION =
  /^#{0,6}\s*(?:Files mentioned by the user|Chrome tabs|Environment context|Here is a list of plugins[^\n]*)\s*:?\s*$/i;

export function extractUserRequest(raw: string): string {
  if (!raw) return '';

  const marker = REQUEST_MARKER.exec(raw);
  if (marker && marker.index >= 0) {
    return raw.slice(marker.index + marker[0].length).trim();
  }

  // No marker. Codex's synthetic blocks always lead, and their bodies are
  // headings, list items, or blank lines. The first line of ordinary prose is
  // the human speaking, so the section ends there and everything after is kept
  // verbatim — a level-1 section must not swallow the request that follows it.
  const lines = raw.split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    // Injected blocks usually arrive as markdown headings, but some versions
    // emit the same labels as bare lines.
    const isHeading = /^#{1,6}\s/.test(line) || SYNTHETIC_SECTION.test(line);
    const isSectionBody = line.trim() === '' || /^\s*[-*+]\s/.test(line) || /^\s+/.test(line);

    if (isHeading) {
      skipping = SYNTHETIC_SECTION.test(line);
      if (skipping) continue;
    } else if (skipping && !isSectionBody) {
      // Ordinary prose: the synthetic block is over.
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join('\n').trim();
}

/** Tool arguments arrive as a JSON string on `function_call`, or as an object. */
function parseArgs(v: unknown): Record<string, unknown> {
  if (isRecord(v)) return v;
  if (typeof v === 'string') {
    const parsed = safeJsonParse(v);
    if (isRecord(parsed)) return parsed;
    // `custom_tool_call` sends a raw string body (the patch text itself).
    return { input: v };
  }
  return {};
}

function joinCmd(v: unknown): string {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').join(' ') : '';
}

/**
 * Parse Codex's `apply_patch` envelope:
 *
 *   *** Begin Patch
 *   *** Add File: path/to/file
 *   +new line
 *   *** Update File: other/file
 *   @@ context
 *   -removed
 *   +added
 *   *** End Patch
 */
function parseApplyPatch(text: string, cwd: string | undefined): FileChange[] {
  if (!text || !text.includes('*** ')) return [];
  const out: FileChange[] = [];
  let current: {
    path: string;
    type: 'add' | 'update' | 'delete';
    added: number;
    removed: number;
  } | null = null;
  const flush = (): void => {
    if (!current) return;
    const abs = cwd && !current.path.startsWith('/') ? path.join(cwd, current.path) : current.path;
    out.push({
      path: abs,
      changeType: current.type,
      linesAdded: current.added,
      linesRemoved: current.removed,
      generated: isGeneratedPath(abs),
      binary: isBinaryPath(abs),
    });
    current = null;
  };

  for (const line of text.split('\n')) {
    const add = /^\*\*\* Add File:\s*(.+)$/.exec(line);
    const upd = /^\*\*\* Update File:\s*(.+)$/.exec(line);
    const del = /^\*\*\* Delete File:\s*(.+)$/.exec(line);
    if (add?.[1]) {
      flush();
      current = { path: add[1].trim(), type: 'add', added: 0, removed: 0 };
      continue;
    }
    if (upd?.[1]) {
      flush();
      current = { path: upd[1].trim(), type: 'update', added: 0, removed: 0 };
      continue;
    }
    if (del?.[1]) {
      flush();
      current = { path: del[1].trim(), type: 'delete', added: 0, removed: 0 };
      continue;
    }
    if (/^\*\*\* (?:Begin|End) Patch/.test(line)) {
      if (line.startsWith('*** End Patch')) flush();
      continue;
    }
    if (!current) continue;
    if (line.startsWith('+')) current.added++;
    else if (line.startsWith('-')) current.removed++;
  }
  flush();
  return out;
}

/**
 * Older Codex builds prefix command output with a metadata preamble:
 *
 *   Chunk ID: d35db3
 *   Wall time: 0.4210 seconds
 *   Process exited with code 0
 *   Original token count: 1925
 *   Output:
 *   <actual output>
 */
function parseExecPreamble(
  text: string | undefined,
): { exitCode?: number; durationMs?: number; body: string } | undefined {
  if (!text) return undefined;
  if (!text.startsWith('Chunk ID:') && !/^Wall time:/m.test(text.slice(0, 200))) return undefined;
  const exitM = /Process exited with code (-?\d+)/.exec(text);
  const wallM = /Wall time:\s*([\d.]+)\s*seconds/.exec(text);
  const outIdx = text.indexOf('\nOutput:\n');
  const body = outIdx >= 0 ? text.slice(outIdx + 9) : text;
  return {
    ...(exitM?.[1] !== undefined ? { exitCode: Number(exitM[1]) } : {}),
    ...(wallM?.[1] !== undefined ? { durationMs: Number(wallM[1]) * 1000 } : {}),
    body,
  };
}

/** Codex writes `command` as a JSON array like ["/bin/zsh","-lc","pytest"]. */
function parseCmdArray(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    const parts = v.filter((x): x is string => typeof x === 'string');
    // Drop the shell wrapper so classification sees the real command.
    if (parts.length >= 3 && /(?:ba|z)?sh$/.test(parts[0] ?? '') && parts[1]?.startsWith('-')) {
      return parts.slice(2).join(' ');
    }
    return parts.join(' ');
  }
  if (typeof v === 'string') {
    // Some versions store a Python-style repr of the array.
    const m = /^\[(.*)\]$/s.exec(v.trim());
    if (m?.[1]) {
      const items = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map(
        (x) => x[1] ?? x[2] ?? '',
      );
      if (items.length >= 3 && /(?:ba|z)?sh$/.test(items[0] ?? '')) return items.slice(2).join(' ');
      if (items.length) return items.join(' ');
    }
    return v;
  }
  return undefined;
}

/** `{ secs, nanos }` → milliseconds. */
function parseDuration(v: unknown): number | undefined {
  if (isRecord(v)) {
    const secs = asNumber(v['secs']) ?? 0;
    const nanos = asNumber(v['nanos']) ?? 0;
    return secs * 1000 + nanos / 1e6;
  }
  return asNumber(v);
}

function parseSecs(v: unknown): number | undefined {
  const n = asNumber(v);
  if (n === undefined) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

function parseMs(v: unknown): number | undefined {
  return asNumber(v);
}

function peekCliVersion(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, 4096, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const m = /"cli_version"\s*:\s*"([^"]+)"/.exec(text);
      return m?.[1];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
