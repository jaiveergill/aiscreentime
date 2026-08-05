import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import { MIGRATIONS } from './migrations.ts';
import { log } from '../core/log.ts';

/**
 * Where the database and log live.
 *
 * The tool was called `leverage` before it was called `screentime`, so an
 * existing install has its whole history under `~/.leverage`. Rather than
 * silently starting empty — which reads as data loss — the old directory is
 * moved across once, on first run, and only when the new one does not yet
 * exist. `LEVERAGE_HOME` is still honoured so an explicit override does not
 * break mid-upgrade.
 */
export function screentimeHome(): string {
  const explicit = process.env.SCREENTIME_HOME ?? process.env.LEVERAGE_HOME;
  if (explicit) return explicit;

  const home = path.join(homedir(), '.screentime');
  if (!fs.existsSync(home)) {
    const legacy = path.join(homedir(), '.leverage');
    if (fs.existsSync(legacy)) {
      try {
        fs.renameSync(legacy, home);
        // The `-wal` and `-shm` sidecars must travel with the database. A
        // renamed `leverage.db` leaves them orphaned, and an orphaned WAL is
        // not inert: it holds real pages — transcript excerpts and absolute
        // paths — in a file SQLite will never open again to clean up.
        for (const [from, to] of [
          ['leverage.db', 'screentime.db'],
          ['leverage.db-wal', 'screentime.db-wal'],
          ['leverage.db-shm', 'screentime.db-shm'],
          ['leverage.log', 'screentime.log'],
        ]) {
          const src = path.join(home, from as string);
          if (fs.existsSync(src)) fs.renameSync(src, path.join(home, to as string));
        }
        log.info('migrated data directory from ~/.leverage', { to: home });
      } catch (err) {
        // A failed move must not stop the tool from starting; the worst case is
        // an empty history, not a crash.
        log.warn('could not migrate ~/.leverage', { err: String(err) });
      }
    }
  }
  return home;
}

/**
 * Create the directory if needed, and make it owner-only either way.
 *
 * The `mode` argument to `mkdirSync` applies only when the directory is
 * created. A directory left behind by an earlier version — or by any run
 * before this rule existed — keeps its original permissions forever, so the
 * mode has to be reasserted on every open rather than assumed. The same trap
 * applies to files: `createWriteStream`'s mode is ignored when appending to an
 * existing one.
 */
export function secureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best effort: a filesystem without permissions, or not our directory */
  }
}

/** Restrict an existing file to owner-only. Silent when it cannot. */
export function secureFile(file: string): void {
  try {
    if (fs.existsSync(file)) fs.chmodSync(file, 0o600);
  } catch {
    /* best effort */
  }
}

export interface OpenOptions {
  /** Directory holding the database. Defaults to `~/.screentime`. */
  readonly dir?: string;
  readonly filename?: string;
  readonly readOnly?: boolean;
}

/**
 * Thin, typed wrapper over `node:sqlite`.
 *
 * Deliberately not an ORM. Queries live in `queries.ts`; this file owns only
 * connection lifecycle, pragmas, and migrations.
 */
/**
 * Adopt a `leverage.db` left by an older version of this tool.
 *
 * Runs for any directory, not just the default home, because `SCREENTIME_HOME`
 * may point at an existing install. Opening a fresh empty database next to a
 * populated old one is indistinguishable from data loss to the person looking
 * at the screen. The WAL sidecars move too, or SQLite would read a stale tail.
 */
function adoptLegacyDb(dir: string, target: string, explicitFilename?: string): void {
  if (explicitFilename || fs.existsSync(target)) return;
  const legacy = path.join(dir, 'leverage.db');
  if (!fs.existsSync(legacy)) return;
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const from = `${legacy}${suffix}`;
      if (fs.existsSync(from)) fs.renameSync(from, `${target}${suffix}`);
    }
    log.info('adopted leverage.db from a previous version', { dir });
  } catch (err) {
    log.warn('could not adopt leverage.db', { err: String(err) });
  }
}

export class Db {
  readonly handle: DatabaseSync;
  readonly file: string;
  readonly dir: string;

  constructor(opts: OpenOptions = {}) {
    this.dir = opts.dir ?? screentimeHome();
    // Owner-only: this database holds transcript excerpts, absolute repo paths
    // and task titles. On a shared machine the default umask would leave it
    // world-readable.
    secureDir(this.dir);
    this.file = path.join(this.dir, opts.filename ?? 'screentime.db');
    adoptLegacyDb(this.dir, this.file, opts.filename);
    this.handle = new DatabaseSync(this.file, { readOnly: opts.readOnly ?? false });
    if (!opts.readOnly) {
      // The sidecars matter as much as the database: a `-wal` holds the same
      // pages, so leaving it readable leaks exactly what locking the database
      // was meant to prevent.
      for (const suffix of ['', '-wal', '-shm']) secureFile(`${this.file}${suffix}`);
      // WAL keeps the dashboard readable while ingestion writes.
      this.handle.exec('PRAGMA journal_mode = WAL');
      this.handle.exec('PRAGMA synchronous = NORMAL');
      this.handle.exec('PRAGMA foreign_keys = ON');
      this.handle.exec('PRAGMA busy_timeout = 5000');
      this.migrate();
    }
  }

  private migrate(): void {
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name    TEXT NOT NULL,
        applied_at INTEGER NOT NULL
      )
    `);
    const applied = new Set(
      (
        this.handle.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]
      ).map((r) => r.version),
    );
    for (let i = 0; i < MIGRATIONS.length; i++) {
      const version = i + 1;
      if (applied.has(version)) continue;
      const m = MIGRATIONS[i];
      if (!m) continue;
      log.info('applying migration', { version, name: m.name });
      this.handle.exec('BEGIN');
      try {
        this.handle.exec(m.up);
        this.handle
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(version, m.name, Date.now());
        this.handle.exec('COMMIT');
      } catch (err) {
        this.handle.exec('ROLLBACK');
        throw new Error(`Migration ${version} (${m.name}) failed: ${String(err)}`);
      }
    }
  }

  transaction<T>(fn: () => T): T {
    this.handle.exec('BEGIN');
    try {
      const out = fn();
      this.handle.exec('COMMIT');
      return out;
    } catch (err) {
      try {
        this.handle.exec('ROLLBACK');
      } catch {
        /* already rolled back */
      }
      throw err;
    }
  }

  /** Config values are JSON-encoded so callers get typed reads. */
  getConfig<T>(key: string, fallback: T): T {
    const row = this.handle.prepare('SELECT value FROM config WHERE key = ?').get(key) as
      { value: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setConfig(key: string, value: unknown): void {
    this.handle
      .prepare(
        'INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  allConfig(): Record<string, unknown> {
    const rows = this.handle.prepare('SELECT key, value FROM config').all() as {
      key: string;
      value: string;
    }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value);
      } catch {
        out[r.key] = r.value;
      }
    }
    return out;
  }

  /** Total on-disk footprint of derived data. Shown in the privacy panel. */
  sizeBytes(): number {
    let total = 0;
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        total += fs.statSync(`${this.file}${suffix}`).size;
      } catch {
        /* not present */
      }
    }
    return total;
  }

  close(): void {
    try {
      this.handle.close();
    } catch {
      /* already closed */
    }
  }
}
