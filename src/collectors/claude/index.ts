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
import { classifyCommand, classifyOutcome, looksInterrupted } from '../../normalize/commands.ts';
import { isGeneratedPath } from '../../normalize/paths.ts';
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

const PROVIDER: ProviderId = 'claude-code';
const PARSER = 'claude-code/v2';

/**
 * Claude Code stores one JSONL transcript per session under
 * `~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl`.
 *
 * Verified against transcripts written by CLI versions 2.1.197 – 2.1.220.
 * Record types observed:
 *   user | assistant | system | attachment | file-history-snapshot |
 *   file-history-delta | mode | permission-mode | ai-title | last-prompt |
 *   agent-name | queue-operation | frame-link
 *
 * Everything else is counted in `unknownTypes` and skipped, never fatal.
 */
export class ClaudeCodeCollector implements Collector {
  readonly id = PROVIDER;
  readonly displayName = 'Claude Code';

  private readonly home: string;

  constructor(home?: string) {
    this.home = home ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), '.claude');
  }

  dataDirs(): string[] {
    return [path.join(this.home, 'projects')];
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
      const v = peekVersion(f.path);
      if (v) versions.add(v);
    }
    const notes: string[] = [];
    if (found.length === 0) {
      notes.push(
        'No ~/.claude/projects directory found. Claude Code may not be installed, or it may store data elsewhere via CLAUDE_CONFIG_DIR.',
      );
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

  async discover(): Promise<SourceFile[]> {
    const root = path.join(this.home, 'projects');
    if (!fs.existsSync(root)) return [];
    const out: SourceFile[] = [];
    let projectDirs: fs.Dirent[];
    try {
      projectDirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const pd of projectDirs) {
      if (!pd.isDirectory()) continue;
      const dir = path.join(root, pd.name);
      // Transcripts live at the top level, but subagent transcripts are nested
      // under `<session>/subagents/**` — including a further `workflows/<id>/`
      // level. Those files hold the actual work of parallel agents, so missing
      // them would erase most of the parallelism this product measures.
      const entries: { name: string; full: string }[] = [];
      const walk = (d: string, depth: number): void => {
        if (depth > 4) return;
        let items: fs.Dirent[];
        try {
          items = fs.readdirSync(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const it of items) {
          const full = path.join(d, it.name);
          if (it.isDirectory()) walk(full, depth + 1);
          else if (it.isFile() && it.name.endsWith('.jsonl')) entries.push({ name: it.name, full });
        }
      };
      walk(dir, 0);

      for (const e of entries) {
        const full = e.full;
        try {
          const st = fs.statSync(full);
          out.push({
            provider: PROVIDER,
            path: full,
            size: st.size,
            mtimeMs: st.mtimeMs,
            sessionHint: e.name.replace(/\.jsonl$/, ''),
            projectHint: unslugProject(pd.name),
          });
        } catch {
          /* file vanished mid-scan; skip */
        }
      }
    }
    out.sort((a, b) => a.mtimeMs - b.mtimeMs);
    return out;
  }

  async parse(file: SourceFile, ctx: ParseContext): Promise<ParseResult> {
    const h = new HealthAccumulator(PROVIDER, PARSER);
    h.filesSeen = 1;
    const events: NormalizedEvent[] = [];
    const sessionSeeds = new Map<string, SessionSeed>();

    // Uuids seen before a compact boundary get marked as replay if they
    // reappear; Claude Code re-emits a summarised prefix after compaction.
    const seenUuids = new Set<string>();
    let replayDepth = 0;
    /** Last timestamp observed in this file, for records that carry none. */
    let lastTs: number | undefined;
    /**
     * Claude Code splits a command and its output across two records: the
     * `tool_use` carries the command, and a later `toolUseResult` carries the
     * output. Verification needs them joined, so pending command events are
     * held by tool-call id and their outcome is backfilled when the result
     * arrives.
     */
    const pendingByCallId = new Map<string, Record<string, unknown>>();

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
        const type = asString(rec['type']) ?? '';
        const version = asString(rec['version']);
        h.version(version);

        const parentSessionId =
          asString(rec['sessionId']) ??
          asString(rec['session_id']) ??
          file.sessionHint ??
          'unknown';
        const uuid = asString(rec['uuid']);
        const ts = parseTs(rec['timestamp']);
        if (ts !== undefined) lastTs = ts;
        const cwd = asString(rec['cwd']);
        const branch = asString(rec['gitBranch']);
        const isSidechain = rec['isSidechain'] === true;
        const agentId = asString(rec['agentId']);

        // Subagent transcripts carry the *parent's* sessionId. Reusing it would
        // collapse every parallel worker into the parent's single channel and
        // erase the concurrency. Give each subagent its own session identity and
        // record the parent separately.
        const sessionId =
          isSidechain && agentId ? `${parentSessionId}::agent-${agentId}` : parentSessionId;

        // Track session metadata as we go.
        if (!sessionSeeds.has(sessionId)) {
          sessionSeeds.set(sessionId, {
            sessionId,
            provider: PROVIDER,
            sourceFile: file.path,
            kind: isSidechain ? 'subagent' : 'primary',
            ...(isSidechain && agentId ? { parentSessionId } : {}),
            ...(cwd ? { cwd } : {}),
            ...(branch ? { branch } : {}),
            ...(version ? { providerVersion: version } : {}),
          });
        } else {
          const prev = sessionSeeds.get(sessionId) as SessionSeed;
          sessionSeeds.set(sessionId, {
            ...prev,
            ...(cwd && !prev.cwd ? { cwd } : {}),
            ...(branch && !prev.branch ? { branch } : {}),
            ...(version ? { providerVersion: version } : {}),
          });
        }

        // Duplicate detection: identical uuid seen twice in one file means the
        // record was replayed (resume/compaction), not new work.
        let isReplay = replayDepth > 0;
        if (uuid) {
          if (seenUuids.has(uuid)) {
            h.recordsDuplicate++;
            isReplay = true;
          } else {
            seenUuids.add(uuid);
          }
        }

        const base = {
          sessionId,
          provider: PROVIDER,
          isSubagent: isSidechain,
          isReplay,
          ...(cwd ? { cwd } : {}),
        };
        const prov = {
          provider: PROVIDER,
          sourceFile: file.path,
          lineIndex: line.lineIndex,
          byteOffset: line.byteOffset,
          parser: PARSER,
          ...(version ? { providerVersion: version } : {}),
        };

        const push = (
          kind: EventKind,
          at: number | undefined,
          payload: EventPayload,
        ): Record<string, unknown> | undefined => {
          const when = at ?? ts;
          if (when === undefined) {
            // Without a timestamp the event cannot participate in any timeline.
            h.recordsIgnored++;
            return undefined;
          }
          const id = hashId(
            PROVIDER,
            file.path,
            line.lineIndex,
            kind,
            uuid ?? '',
            payload.toolCallId ?? '',
          );
          if (ctx.seen.has(id)) {
            h.recordsDuplicate++;
            return undefined;
          }
          ctx.seen.add(id);
          const mutable = { ...payload } as Record<string, unknown>;
          const ev: NormalizedEvent = {
            id,
            kind,
            ts: when,
            ...(asString(rec['timestamp']) ? { tsRaw: asString(rec['timestamp']) as string } : {}),
            ...base,
            payload: mutable as EventPayload,
            provenance: prov,
          };
          events.push(ev);
          h.eventsEmitted++;
          if (isReplay) h.recordsReplay++;
          return mutable;
        };

        switch (type) {
          case 'user':
            handleUser(rec, push, rd, h, pendingByCallId);
            break;
          case 'assistant':
            handleAssistant(rec, push, rd, h, pendingByCallId);
            break;
          case 'system':
            replayDepth = handleSystem(rec, push, rd, replayDepth);
            break;
          case 'attachment':
            handleAttachment(rec, push, rd);
            break;
          case 'ai-title': {
            const title = asString(rec['aiTitle']);
            if (title) {
              const prev = sessionSeeds.get(sessionId);
              if (prev) sessionSeeds.set(sessionId, { ...prev, title: rd(title, 200) as string });
            }
            h.recordsIgnored++;
            break;
          }
          case 'agent-name': {
            const name = asString(rec['agentName']);
            if (name) {
              const prev = sessionSeeds.get(sessionId);
              if (prev && !prev.title) {
                sessionSeeds.set(sessionId, { ...prev, title: rd(name, 200) as string });
              }
            }
            h.recordsIgnored++;
            break;
          }
          case 'file-history-delta': {
            const trackingPath = asString(rec['trackingPath']);
            const at = parseTs(rec['timestamp']);
            if (trackingPath) {
              push('file.modified', at, {
                rawType: type,
                paths: [trackingPath],
                files: [
                  {
                    path: trackingPath,
                    changeType: 'update',
                    linesAdded: 0,
                    linesRemoved: 0,
                    generated: isGeneratedPath(trackingPath),
                    binary: false,
                  },
                ],
              });
            } else {
              h.recordsIgnored++;
            }
            break;
          }
          // Subagent lifecycle markers inside delegated transcripts. These
          // carry no timestamp of their own, so they borrow the last one seen
          // in the file rather than being dropped.
          case 'started':
            push('subagent.spawned', lastTs, {
              rawType: type,
              ...(asString(rec['agentId'])
                ? { subagentId: asString(rec['agentId']) as string }
                : {}),
            });
            break;
          case 'result':
            push('subagent.completed', lastTs, {
              rawType: type,
              ...(asString(rec['agentId'])
                ? { subagentId: asString(rec['agentId']) as string }
                : {}),
              text: rd(asString(rec['result']), 800),
            });
            break;

          // Structural records with no analytic value of their own.
          case 'file-history-snapshot':
          case 'mode':
          case 'permission-mode':
          case 'last-prompt':
          case 'queue-operation':
          case 'frame-link':
            h.recordsIgnored++;
            break;
          default:
            h.unknown(type || '<missing type>');
            h.recordsIgnored++;
        }
      },
      ctx.signal,
    );

    h.bytesRead = scan.bytesConsumed - ctx.fromByte;

    return {
      events,
      bytesConsumed: scan.bytesConsumed,
      linesConsumed: scan.linesConsumed,
      health: h.freeze(),
      sessions: [...sessionSeeds.values()],
    };
  }
}

type PushFn = (
  kind: EventKind,
  at: number | undefined,
  payload: EventPayload,
) => Record<string, unknown> | undefined;
type PendingMap = Map<string, Record<string, unknown>>;
type RedactFn = (s: string | undefined, cap?: number) => string | undefined;

// ---------------------------------------------------------------------------
// Record handlers
// ---------------------------------------------------------------------------

function handleUser(
  rec: Record<string, unknown>,
  push: PushFn,
  rd: RedactFn,
  h: HealthAccumulator,
  pending: PendingMap,
): void {
  const msg = rec['message'];
  const toolUseResult = rec['toolUseResult'];
  const isMeta = rec['isMeta'] === true;

  // Tool results arrive as `user` records carrying `toolUseResult`.
  if (toolUseResult !== undefined) {
    emitToolResult(rec, toolUseResult, push, rd, pending);
    return;
  }

  if (!isRecord(msg)) {
    h.recordsIgnored++;
    return;
  }
  const content = msg['content'];
  let text = '';
  if (typeof content === 'string') text = content;
  else {
    for (const block of asArray(content)) {
      if (isRecord(block) && block['type'] === 'text') text += `${asString(block['text']) ?? ''}\n`;
      if (isRecord(block) && block['type'] === 'tool_result') {
        // A tool_result block without toolUseResult metadata — still evidence.
        emitToolResult(rec, block['content'], push, rd, pending);
      }
    }
  }
  text = text.trim();
  if (text.length === 0) {
    h.recordsIgnored++;
    return;
  }

  // Interruptions are surfaced by Claude Code as a distinctive user message.
  if (/\[Request interrupted by user/i.test(text)) {
    push('user.interrupt', undefined, {
      rawType: 'user',
      reason: 'interrupted',
      text: rd(text, 300),
    });
    return;
  }
  // System-injected reminders and hook context are not human instructions.
  if (isMeta || /^<(?:system-reminder|command-name|local-command|task-notification)/i.test(text)) {
    push('assistant.reasoning', undefined, { rawType: 'user:meta', text: rd(text, 500) });
    return;
  }
  push('user.instruction', undefined, { rawType: 'user', text: rd(text, 4000) });
}

function handleAssistant(
  rec: Record<string, unknown>,
  push: PushFn,
  rd: RedactFn,
  h: HealthAccumulator,
  pending: PendingMap,
): void {
  const msg = rec['message'];
  if (!isRecord(msg)) {
    h.recordsIgnored++;
    return;
  }
  const model = asString(msg['model']);
  const usage = msg['usage'];
  if (isRecord(usage)) {
    push('tokens.reported', undefined, {
      rawType: 'assistant:usage',
      ...(model ? { model } : {}),
      tokensIn: asNumber(usage['input_tokens']) ?? 0,
      tokensOut: asNumber(usage['output_tokens']) ?? 0,
      tokensCacheRead: asNumber(usage['cache_read_input_tokens']) ?? 0,
      tokensCacheWrite: asNumber(usage['cache_creation_input_tokens']) ?? 0,
    });
  }

  let text = '';
  for (const block of asArray(msg['content'])) {
    if (!isRecord(block)) continue;
    const bt = asString(block['type']);
    if (bt === 'text') {
      text += `${asString(block['text']) ?? ''}\n`;
    } else if (bt === 'thinking') {
      // Reasoning metadata: length is recorded, content is not stored.
      const thinking = asString(block['thinking']) ?? '';
      push('assistant.reasoning', undefined, {
        rawType: 'thinking',
        text: `[${thinking.length} chars of reasoning]`,
      });
    } else if (bt === 'tool_use') {
      emitToolUse(block, push, rd, pending);
    }
  }
  text = text.trim();
  if (text.length > 0) {
    push('assistant.message', undefined, {
      rawType: 'assistant',
      text: rd(text, 3000),
      ...(model ? { model } : {}),
    });
  }
}

function emitToolUse(
  block: Record<string, unknown>,
  push: PushFn,
  rd: RedactFn,
  pending: PendingMap,
): void {
  const name = asString(block['name']) ?? 'unknown';
  const id = asString(block['id']);
  const input = isRecord(block['input']) ? block['input'] : {};

  const payloadBase: EventPayload = {
    rawType: 'tool_use',
    toolName: name,
    ...(id ? { toolCallId: id } : {}),
  };

  switch (name) {
    case 'Bash': {
      const command = asString(input['command']) ?? '';
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
      const payload = push(kind, undefined, { ...payloadBase, command: rd(command, 1000) });
      // Only verification-class commands need their outcome joined back; a
      // `cd` or `ls` result tells us nothing worth correlating.
      if (payload && id && info.isVerification) pending.set(id, payload);
      break;
    }
    case 'Read':
    case 'NotebookRead': {
      const fp = asString(input['file_path']);
      push('file.read', undefined, { ...payloadBase, ...(fp ? { paths: [fp] } : {}) });
      break;
    }
    case 'Write': {
      const fp = asString(input['file_path']);
      const content = asString(input['content']) ?? '';
      push('file.created', undefined, {
        ...payloadBase,
        ...(fp ? { paths: [fp] } : {}),
        ...(fp
          ? {
              files: [
                {
                  path: fp,
                  changeType: 'add' as const,
                  linesAdded: countLines(content),
                  linesRemoved: 0,
                  generated: isGeneratedPath(fp),
                  binary: false,
                },
              ],
            }
          : {}),
      });
      break;
    }
    case 'Edit':
    case 'NotebookEdit': {
      const fp = asString(input['file_path']) ?? asString(input['notebook_path']);
      const oldS = asString(input['old_string']) ?? '';
      const newS = asString(input['new_string']) ?? '';
      push('file.modified', undefined, {
        ...payloadBase,
        ...(fp ? { paths: [fp] } : {}),
        ...(fp
          ? {
              files: [
                {
                  path: fp,
                  changeType: 'update' as const,
                  linesAdded: countLines(newS),
                  linesRemoved: countLines(oldS),
                  generated: isGeneratedPath(fp),
                  binary: false,
                },
              ],
            }
          : {}),
      });
      break;
    }
    case 'Grep':
    case 'Glob':
      push('search.performed', undefined, {
        ...payloadBase,
        text: rd(asString(input['pattern']), 200),
      });
      break;
    case 'WebSearch':
      push('search.performed', undefined, {
        ...payloadBase,
        text: rd(asString(input['query']), 200),
      });
      break;
    case 'WebFetch':
      push('web.fetched', undefined, { ...payloadBase, text: rd(asString(input['url']), 300) });
      break;
    case 'Agent':
    case 'Task':
      push('subagent.spawned', undefined, {
        ...payloadBase,
        ...(id ? { subagentId: id } : {}),
        subagentLabel: rd(asString(input['description']) ?? asString(input['subagent_type']), 120),
      });
      break;
    case 'AskUserQuestion':
      push('approval.requested', undefined, { ...payloadBase });
      break;
    default:
      push('tool.invoked', undefined, payloadBase);
  }
}

function emitToolResult(
  rec: Record<string, unknown>,
  result: unknown,
  push: PushFn,
  rd: RedactFn,
  pending: PendingMap,
): void {
  const msg = isRecord(rec['message']) ? rec['message'] : {};
  let toolCallId: string | undefined;
  for (const block of asArray(msg['content'])) {
    if (isRecord(block) && block['type'] === 'tool_result') {
      toolCallId = asString(block['tool_use_id']);
      break;
    }
  }
  const base: EventPayload = { rawType: 'toolUseResult', ...(toolCallId ? { toolCallId } : {}) };

  if (!isRecord(result)) {
    push('tool.result', undefined, {
      ...base,
      text: rd(typeof result === 'string' ? result : undefined, 800),
    });
    return;
  }

  // Bash-shaped results.
  if ('stdout' in result || 'stderr' in result) {
    const stdout = asString(result['stdout']) ?? '';
    const stderr = asString(result['stderr']) ?? '';
    const interrupted = result['interrupted'] === true || looksInterrupted(stderr);
    const outcome = classifyOutcome(undefined, stdout, stderr);

    // Join the outcome back onto the command event. Without this, a passing
    // test suite is invisible to verification, because the `test.run` event
    // carries the command and this record carries the result.
    if (toolCallId) {
      const target = pending.get(toolCallId);
      if (target) {
        target['outcome'] = outcome;
        if (interrupted) target['reason'] = 'interrupted';
        pending.delete(toolCallId);
      }
    }

    push('tool.result', undefined, {
      ...base,
      outcome,
      text: rd(`${stdout}\n${stderr}`.trim(), 1200),
      ...(interrupted ? { reason: 'interrupted' } : {}),
    });
    if (outcome === 'fail') {
      push('error.encountered', undefined, { ...base, text: rd(stderr || stdout, 600) });
    }
    if (interrupted) push('user.interrupt', undefined, { ...base, reason: 'tool-interrupted' });
    return;
  }

  // Edit/Write-shaped results carry a structuredPatch.
  const patch = result['structuredPatch'];
  const filePath = asString(result['filePath']) ?? asString(result['file']);
  if (Array.isArray(patch) && filePath) {
    let added = 0;
    let removed = 0;
    for (const hunk of patch) {
      if (!isRecord(hunk)) continue;
      for (const l of asArray(hunk['lines'])) {
        const s = asString(l) ?? '';
        if (s.startsWith('+')) added++;
        else if (s.startsWith('-')) removed++;
      }
    }
    const changeType = asString(result['type']) === 'create' ? 'add' : 'update';
    const change: FileChange = {
      path: filePath,
      changeType,
      linesAdded: added,
      linesRemoved: removed,
      generated: isGeneratedPath(filePath),
      binary: false,
    };
    push(changeType === 'add' ? 'file.created' : 'file.modified', undefined, {
      ...base,
      paths: [filePath],
      files: [change],
      ...(result['userModified'] === true ? { reason: 'user-modified' } : {}),
    });
    return;
  }

  // Agent/Task results.
  if ('agentId' in result || 'prompt' in result) {
    push('subagent.completed', undefined, {
      ...base,
      ...(asString(result['agentId']) ? { subagentId: asString(result['agentId']) as string } : {}),
      text: rd(asString(result['description']), 200),
    });
    return;
  }

  push('tool.result', undefined, { ...base, text: rd(asString(result['content']), 600) });
}

function handleSystem(
  rec: Record<string, unknown>,
  push: PushFn,
  rd: RedactFn,
  replayDepth: number,
): number {
  const subtype = asString(rec['subtype']) ?? '';
  switch (subtype) {
    case 'turn_duration': {
      const durationMs = asNumber(rec['durationMs']);
      push('turn.completed', undefined, {
        rawType: 'turn_duration',
        ...(durationMs !== undefined ? { durationMs } : {}),
      });
      return replayDepth;
    }
    case 'compact_boundary': {
      const meta = isRecord(rec['compactMetadata']) ? rec['compactMetadata'] : {};
      push('session.compacted', undefined, {
        rawType: 'compact_boundary',
        droppedTokens: asNumber(meta['cumulativeDroppedTokens']) ?? 0,
        reason: asString(meta['trigger']) ?? 'unknown',
      });
      return replayDepth;
    }
    case 'local_command':
      push('user.instruction', undefined, {
        rawType: 'local_command',
        text: rd(asString(rec['content']), 300),
      });
      return replayDepth;
    case 'away_summary':
    case 'stop_hook_summary':
    case 'informational':
    case 'scheduled_task_fire':
    case 'model_refusal_fallback':
      return replayDepth;
    default:
      return replayDepth;
  }
}

function handleAttachment(rec: Record<string, unknown>, push: PushFn, rd: RedactFn): void {
  const att = rec['attachment'];
  if (!isRecord(att)) return;
  const t = asString(att['type']);
  if (t === 'diagnostics') {
    let count = 0;
    for (const f of asArray(att['files'])) {
      if (isRecord(f)) count += asArray(f['diagnostics']).length;
    }
    if (count > 0) {
      push('error.encountered', undefined, {
        rawType: 'diagnostics',
        text: `${count} IDE diagnostic(s)`,
      });
    }
  } else if (t === 'edited_text_file') {
    const fn = asString(att['filename']);
    if (fn) {
      // A file the *human* edited outside the agent. Critical for attribution.
      push('file.modified', undefined, {
        rawType: 'edited_text_file',
        paths: [fn],
        reason: 'human-edit',
        files: [
          {
            path: fn,
            changeType: 'update',
            linesAdded: 0,
            linesRemoved: 0,
            generated: isGeneratedPath(fn),
            binary: false,
          },
        ],
      });
    }
  } else if (t === 'goal_status') {
    push('verification.result', undefined, {
      rawType: 'goal_status',
      outcome: att['met'] === true ? 'pass' : 'unknown',
      text: rd(asString(att['condition']), 200),
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countLines(s: string): number {
  if (s.length === 0) return 0;
  let n = 1;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

/**
 * Claude Code slugifies the cwd into the project directory name by replacing
 * path separators and dots with `-`. The transform is lossy, so this is only a
 * hint; the authoritative cwd comes from the records themselves.
 */
function unslugProject(slug: string): string {
  return slug.replace(/^-/, '/').replace(/-/g, '/');
}

function peekVersion(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0);
      const text = buf.subarray(0, n).toString('utf8');
      const m = /"version"\s*:\s*"([^"]+)"/.exec(text);
      return m?.[1];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
