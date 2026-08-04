import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';

import { MIGRATIONS } from './migrations.ts';
import { log } from '../core/log.ts';

export function leverageHome(): string {
  return process.env.LEVERAGE_HOME ?? path.join(homedir(), '.leverage');
}

export interface OpenOptions {
  /** Directory holding the database. Defaults to `~/.leverage`. */
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
export class Db {
  readonly handle: DatabaseSync;
  readonly file: string;
  readonly dir: string;

  constructor(opts: OpenOptions = {}) {
    this.dir = opts.dir ?? leverageHome();
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, opts.filename ?? 'leverage.db');
    this.handle = new DatabaseSync(this.file, { readOnly: opts.readOnly ?? false });
    if (!opts.readOnly) {
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
