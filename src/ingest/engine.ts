import fs from 'node:fs';

import type { NormalizedEvent, ParserHealth, ProviderId } from '../core/types.ts';
import { log } from '../core/log.ts';
import type { Db } from '../store/db.ts';
import type { Settings } from '../core/config.ts';
import { headFingerprint } from '../collectors/jsonl.ts';
import { emptyHealth, mergeHealth, type Collector, type SourceFile } from '../collectors/types.ts';
import { resolveRepo } from '../repo/resolve.ts';

export interface IngestProgress {
  readonly stage: 'discover' | 'parse' | 'index' | 'done';
  readonly provider?: ProviderId;
  readonly file?: string;
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly eventsIngested: number;
  readonly bytesRead: number;
}

export interface IngestOptions {
  readonly collectors: readonly Collector[];
  readonly settings: Settings;
  readonly signal?: AbortSignal;
  readonly onProgress?: (p: IngestProgress) => void;
  /** Only ingest files modified at or after this instant. */
  readonly since?: number;
  /** Cap on bytes parsed in one run. Keeps first-launch responsive. */
  readonly maxBytes?: number;
}

export interface IngestResult {
  readonly filesScanned: number;
  readonly filesParsed: number;
  readonly filesSkipped: number;
  readonly eventsIngested: number;
  readonly bytesRead: number;
  readonly durationMs: number;
  readonly health: Record<string, ParserHealth>;
  readonly truncatedFiles: string[];
  readonly cancelled: boolean;
  /**
   * Time range actually touched by newly ingested events. Lets the caller
   * recompute only the affected days instead of eight months of history.
   * Undefined when nothing new was ingested.
   */
  readonly touchedFrom?: number;
  readonly touchedTo?: number;
}

interface SourceRow {
  path: string;
  size: number;
  mtime_ms: number;
  bytes_consumed: number;
  lines_consumed: number;
  head_fingerprint: string;
}

/**
 * Incremental ingestion.
 *
 * For each discovered transcript we keep a cursor: `(bytes_consumed,
 * lines_consumed, head_fingerprint, size, mtime)`. On each run:
 *
 *  - unchanged size and mtime  → skip the file entirely (no read at all)
 *  - grown, same head          → parse only the appended bytes
 *  - shrunk, or head changed   → the file was truncated, rotated or rewritten;
 *                                reset the cursor and re-parse from zero
 *  - missing                   → mark the source `missing`, keep its events
 *
 * Because event ids are content-addressed over (file, line, kind, call id), a
 * full re-parse after a rewrite is idempotent: previously-seen events collide
 * on primary key and are ignored.
 */
export async function ingest(db: Db, opts: IngestOptions): Promise<IngestResult> {
  const t0 = Date.now();
  const health: Record<string, ParserHealth> = {};
  const truncatedFiles: string[] = [];
  let filesScanned = 0;
  let filesParsed = 0;
  let filesSkipped = 0;
  let eventsIngested = 0;
  let bytesRead = 0;
  let cancelled = false;
  let touchedFrom: number | undefined;
  let touchedTo: number | undefined;

  const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
  const since =
    opts.since ??
    (opts.settings.historyDays > 0 ? Date.now() - opts.settings.historyDays * 24 * 3600 * 1000 : 0);

  const insertEvent = db.handle.prepare(`
    INSERT OR IGNORE INTO events
      (id, session_id, provider, kind, ts, ts_raw, cwd, repo_id, turn_id,
       is_subagent, is_replay, payload, src_file, src_line, src_byte, parser, provider_version)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  const upsertSource = db.handle.prepare(`
    INSERT INTO sources (path, provider, size, mtime_ms, bytes_consumed, lines_consumed,
                         head_fingerprint, last_ingested, events_ingested, status, note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime_ms = excluded.mtime_ms,
      bytes_consumed = excluded.bytes_consumed, lines_consumed = excluded.lines_consumed,
      head_fingerprint = excluded.head_fingerprint, last_ingested = excluded.last_ingested,
      events_ingested = sources.events_ingested + excluded.events_ingested,
      status = excluded.status, note = excluded.note
  `);
  const selectSource = db.handle.prepare('SELECT * FROM sources WHERE path = ?');
  const upsertRepo = db.handle.prepare(`
    INSERT INTO repos (repo_id, root, name, is_git, worktree_of, included, last_scanned)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(repo_id) DO UPDATE SET last_scanned = excluded.last_scanned
  `);

  // ---- discovery ---------------------------------------------------------
  const allFiles: { collector: Collector; file: SourceFile }[] = [];
  for (const c of opts.collectors) {
    if (opts.settings.providers[c.id] === false) continue;
    let files: SourceFile[] = [];
    try {
      files = await c.discover();
    } catch (err) {
      log.error('discovery failed', { provider: c.id, err: String(err) });
      continue;
    }
    for (const f of files) {
      if (since > 0 && f.mtimeMs < since) {
        filesSkipped++;
        continue;
      }
      allFiles.push({ collector: c, file: f });
    }
  }
  filesScanned = allFiles.length;
  // Newest first: a user who cancels early still gets today's data.
  allFiles.sort((a, b) => b.file.mtimeMs - a.file.mtimeMs);
  opts.onProgress?.({
    stage: 'discover',
    filesTotal: filesScanned,
    filesDone: 0,
    eventsIngested: 0,
    bytesRead: 0,
  });

  const excludedRepos = new Set(opts.settings.excludedRepos);
  const excludedSessions = new Set(opts.settings.excludedSessions);

  // ---- parse -------------------------------------------------------------
  for (const { collector, file } of allFiles) {
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (bytesRead >= maxBytes) {
      log.warn('ingest byte budget reached; remaining files deferred', { bytesRead });
      break;
    }

    const prev = selectSource.get(file.path) as SourceRow | undefined;
    let fromByte = 0;
    let fromLine = 0;
    let note: string | null = null;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(file.path);
    } catch {
      if (prev) {
        upsertSource.run(
          file.path,
          collector.id,
          prev.size,
          prev.mtime_ms,
          prev.bytes_consumed,
          prev.lines_consumed,
          prev.head_fingerprint,
          Date.now(),
          0,
          'missing',
          'file no longer present',
        );
      }
      filesSkipped++;
      continue;
    }

    if (prev) {
      const unchanged = prev.size === stat.size && prev.mtime_ms === stat.mtimeMs;
      if (unchanged && prev.bytes_consumed >= stat.size) {
        filesSkipped++;
        continue;
      }
      if (stat.size < prev.bytes_consumed) {
        // Truncated or replaced with a smaller file.
        truncatedFiles.push(file.path);
        note = 'truncated — re-parsed from start';
        log.warn('source truncated; resetting cursor', { path: file.path });
      } else {
        const fp = headFingerprint(file.path);
        if (prev.head_fingerprint && fp && fp !== prev.head_fingerprint) {
          truncatedFiles.push(file.path);
          note = 'head changed — re-parsed from start';
          log.warn('source head changed; resetting cursor', { path: file.path });
        } else {
          fromByte = prev.bytes_consumed;
          fromLine = prev.lines_consumed;
        }
      }
    }

    let parsed;
    try {
      parsed = await collector.parse(file, {
        fromByte,
        fromLine,
        seen: new Set<string>(),
        redactMode: opts.settings.redactMode,
        customRedactTerms: opts.settings.customRedactTerms,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      log.error('parse failed', { path: file.path, err: String(err) });
      upsertSource.run(
        file.path,
        collector.id,
        stat.size,
        stat.mtimeMs,
        fromByte,
        fromLine,
        headFingerprint(file.path),
        Date.now(),
        0,
        'error',
        String(err).slice(0, 300),
      );
      continue;
    }

    // ---- index ----------------------------------------------------------
    const events = parsed.events.filter((e) => !excludedSessions.has(e.sessionId));
    let inserted = 0;
    db.transaction(() => {
      for (const ev of events) {
        const repo = resolveRepo(ev.cwd);
        if (repo && excludedRepos.has(repo.root)) continue;
        if (repo) {
          upsertRepo.run(
            repo.repoId,
            repo.root,
            repo.name,
            repo.isGit ? 1 : 0,
            repo.worktreeOf ?? null,
            1,
            Date.now(),
          );
        }
        if (touchedFrom === undefined || ev.ts < touchedFrom) touchedFrom = ev.ts;
        if (touchedTo === undefined || ev.ts > touchedTo) touchedTo = ev.ts;
        insertEvent.run(
          ev.id,
          ev.sessionId,
          ev.provider,
          ev.kind,
          ev.ts,
          ev.tsRaw ?? null,
          ev.cwd ?? null,
          repo?.repoId ?? null,
          ev.turnId ?? null,
          ev.isSubagent ? 1 : 0,
          ev.isReplay ? 1 : 0,
          JSON.stringify(ev.payload),
          ev.provenance.sourceFile,
          ev.provenance.lineIndex,
          ev.provenance.byteOffset,
          ev.provenance.parser,
          ev.provenance.providerVersion ?? null,
        );
        inserted++;
      }
      upsertSource.run(
        file.path,
        collector.id,
        stat.size,
        stat.mtimeMs,
        parsed.bytesConsumed,
        parsed.linesConsumed,
        headFingerprint(file.path),
        Date.now(),
        inserted,
        'ok',
        note,
      );
      writeSessions(db, parsed.sessions, events);
    });

    filesParsed++;
    eventsIngested += inserted;
    bytesRead += parsed.health.bytesRead;
    const key = `${parsed.health.provider}/${parsed.health.parser}`;
    health[key] = mergeHealth(
      health[key] ?? emptyHealth(parsed.health.provider, parsed.health.parser),
      parsed.health,
    );

    opts.onProgress?.({
      stage: 'parse',
      provider: collector.id,
      file: file.path,
      filesTotal: filesScanned,
      filesDone: filesParsed + filesSkipped,
      eventsIngested,
      bytesRead,
    });
  }

  // Persist parser health for the collector-debug view.
  const upsertHealth = db.handle.prepare(`
    INSERT INTO parser_health (provider, parser, payload, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(provider, parser) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at
  `);
  for (const h of Object.values(health)) {
    const existing = db.handle
      .prepare('SELECT payload FROM parser_health WHERE provider = ? AND parser = ?')
      .get(h.provider, h.parser) as { payload: string } | undefined;
    const merged = existing ? mergeHealth(JSON.parse(existing.payload) as ParserHealth, h) : h;
    upsertHealth.run(h.provider, h.parser, JSON.stringify(merged), Date.now());
  }

  opts.onProgress?.({
    stage: 'done',
    filesTotal: filesScanned,
    filesDone: filesParsed + filesSkipped,
    eventsIngested,
    bytesRead,
  });

  return {
    filesScanned,
    filesParsed,
    filesSkipped,
    eventsIngested,
    bytesRead,
    durationMs: Date.now() - t0,
    health,
    truncatedFiles,
    cancelled,
    ...(touchedFrom !== undefined ? { touchedFrom } : {}),
    ...(touchedTo !== undefined ? { touchedTo } : {}),
  };
}

/**
 * Derive session rows from the events just ingested.
 *
 * Session bounds are recomputed from the full event range each time so that
 * appending to a transcript extends the session rather than replacing it.
 */
function writeSessions(
  db: Db,
  seeds: {
    sessionId: string;
    provider: ProviderId;
    sourceFile: string;
    cwd?: string;
    branch?: string;
    title?: string;
    model?: string;
    providerVersion?: string;
    parentSessionId?: string;
    kind: string;
  }[],
  events: readonly NormalizedEvent[],
): void {
  if (seeds.length === 0) return;
  const bounds = new Map<
    string,
    { min: number; max: number; count: number; instructions: number }
  >();
  for (const e of events) {
    const b = bounds.get(e.sessionId);
    const isInstruction = e.kind === 'user.instruction' && !e.isReplay ? 1 : 0;
    if (b) {
      if (e.ts < b.min) b.min = e.ts;
      if (e.ts > b.max) b.max = e.ts;
      b.count++;
      b.instructions += isInstruction;
    } else {
      bounds.set(e.sessionId, { min: e.ts, max: e.ts, count: 1, instructions: isInstruction });
    }
  }

  const stmt = db.handle.prepare(`
    INSERT INTO sessions (session_id, provider, source_file, started_at, ended_at, cwd, repo_id,
                          branch, title, model, provider_version, parent_session_id, kind,
                          event_count, user_instruction_count)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at = MIN(sessions.started_at, excluded.started_at),
      ended_at   = MAX(sessions.ended_at, excluded.ended_at),
      cwd        = COALESCE(excluded.cwd, sessions.cwd),
      repo_id    = COALESCE(excluded.repo_id, sessions.repo_id),
      branch     = COALESCE(excluded.branch, sessions.branch),
      title      = COALESCE(excluded.title, sessions.title),
      model      = COALESCE(excluded.model, sessions.model),
      provider_version = COALESCE(excluded.provider_version, sessions.provider_version),
      parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
      event_count = sessions.event_count + excluded.event_count,
      user_instruction_count = sessions.user_instruction_count + excluded.user_instruction_count
  `);

  for (const s of seeds) {
    const b = bounds.get(s.sessionId);
    if (!b) continue;
    const repo = resolveRepo(s.cwd);
    stmt.run(
      s.sessionId,
      s.provider,
      s.sourceFile,
      b.min,
      b.max,
      s.cwd ?? null,
      repo?.repoId ?? null,
      s.branch ?? null,
      s.title ?? null,
      s.model ?? null,
      s.providerVersion ?? null,
      s.parentSessionId ?? null,
      s.kind,
      b.count,
      b.instructions,
    );
  }
}
