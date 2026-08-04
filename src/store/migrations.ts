/**
 * Schema migrations.
 *
 * Append-only: never edit an existing migration, always add a new one. The
 * `version` is the array index + 1. Derived tables (tasks, estimates,
 * day_metrics) can be rebuilt from `events`, so migrations that change derived
 * shapes may drop and recompute; migrations touching `events`, `sources`,
 * `calibrations`, or `task_overrides` must preserve data — that is the only
 * user-owned state we cannot regenerate.
 */
export interface Migration {
  readonly name: string;
  readonly up: string;
}

export const MIGRATIONS: Migration[] = [
  {
    name: '0001-initial',
    up: `
      -- Ingestion cursors. One row per discovered transcript file.
      CREATE TABLE sources (
        path            TEXT PRIMARY KEY,
        provider        TEXT NOT NULL,
        size            INTEGER NOT NULL,
        mtime_ms        REAL NOT NULL,
        bytes_consumed  INTEGER NOT NULL DEFAULT 0,
        lines_consumed  INTEGER NOT NULL DEFAULT 0,
        head_fingerprint TEXT NOT NULL DEFAULT '',
        last_ingested   INTEGER NOT NULL DEFAULT 0,
        events_ingested INTEGER NOT NULL DEFAULT 0,
        status          TEXT NOT NULL DEFAULT 'ok',
        note            TEXT
      );
      CREATE INDEX idx_sources_provider ON sources(provider);

      -- Canonical events. Content-addressed id makes re-ingestion idempotent.
      CREATE TABLE events (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL,
        provider    TEXT NOT NULL,
        kind        TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        ts_raw      TEXT,
        cwd         TEXT,
        repo_id     TEXT,
        turn_id     TEXT,
        is_subagent INTEGER NOT NULL DEFAULT 0,
        is_replay   INTEGER NOT NULL DEFAULT 0,
        payload     TEXT NOT NULL,
        src_file    TEXT NOT NULL,
        src_line    INTEGER NOT NULL,
        src_byte    INTEGER NOT NULL,
        parser      TEXT NOT NULL,
        provider_version TEXT
      );
      CREATE INDEX idx_events_ts ON events(ts);
      CREATE INDEX idx_events_session ON events(session_id, ts);
      CREATE INDEX idx_events_kind ON events(kind, ts);
      CREATE INDEX idx_events_repo ON events(repo_id, ts);

      CREATE TABLE sessions (
        session_id   TEXT PRIMARY KEY,
        provider     TEXT NOT NULL,
        source_file  TEXT NOT NULL,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER NOT NULL,
        cwd          TEXT,
        repo_id      TEXT,
        branch       TEXT,
        title        TEXT,
        model        TEXT,
        provider_version TEXT,
        parent_session_id TEXT,
        kind         TEXT NOT NULL DEFAULT 'primary',
        event_count  INTEGER NOT NULL DEFAULT 0,
        user_instruction_count INTEGER NOT NULL DEFAULT 0,
        excluded     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX idx_sessions_started ON sessions(started_at);
      CREATE INDEX idx_sessions_repo ON sessions(repo_id);

      CREATE TABLE repos (
        repo_id      TEXT PRIMARY KEY,
        root         TEXT NOT NULL UNIQUE,
        name         TEXT NOT NULL,
        alias        TEXT,
        is_git       INTEGER NOT NULL DEFAULT 0,
        worktree_of  TEXT,
        remote_url_hash TEXT,
        file_count   INTEGER,
        included     INTEGER NOT NULL DEFAULT 1,
        last_scanned INTEGER NOT NULL DEFAULT 0
      );

      -- Reconstructed tasks. Fully derived; safe to rebuild.
      CREATE TABLE tasks (
        task_id      TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        intent       TEXT NOT NULL DEFAULT '',
        category     TEXT NOT NULL,
        category_source TEXT NOT NULL DEFAULT 'inferred',
        status       TEXT NOT NULL,
        status_source TEXT NOT NULL DEFAULT 'inferred',
        repo_id      TEXT,
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER NOT NULL,
        day_key      TEXT NOT NULL,
        session_ids  TEXT NOT NULL,
        providers    TEXT NOT NULL,
        evidence     TEXT NOT NULL,
        wall_clock_ms INTEGER NOT NULL DEFAULT 0,
        agent_active_ms INTEGER NOT NULL DEFAULT 0,
        steering_ms  INTEGER NOT NULL DEFAULT 0,
        excluded     INTEGER NOT NULL DEFAULT 0,
        user_edited  INTEGER NOT NULL DEFAULT 0,
        merged_from  TEXT,
        related_task_ids TEXT
      );
      CREATE INDEX idx_tasks_day ON tasks(day_key);
      CREATE INDEX idx_tasks_repo ON tasks(repo_id);
      CREATE INDEX idx_tasks_started ON tasks(started_at);

      CREATE TABLE task_events (
        task_id  TEXT NOT NULL,
        event_id TEXT NOT NULL,
        PRIMARY KEY (task_id, event_id)
      );
      CREATE INDEX idx_task_events_event ON task_events(event_id);

      CREATE TABLE estimates (
        task_id      TEXT NOT NULL,
        benchmark_version TEXT NOT NULL,
        mode         TEXT NOT NULL,
        payload      TEXT NOT NULL,
        computed_at  INTEGER NOT NULL,
        PRIMARY KEY (task_id, benchmark_version, mode)
      );

      -- User-owned state. Never dropped by a migration.
      CREATE TABLE task_overrides (
        task_id      TEXT PRIMARY KEY,
        title        TEXT,
        category     TEXT,
        status       TEXT,
        excluded     INTEGER,
        hours        REAL,
        note         TEXT,
        updated_at   INTEGER NOT NULL
      );

      CREATE TABLE calibrations (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id      TEXT NOT NULL,
        category     TEXT NOT NULL,
        estimated_hours REAL NOT NULL,
        user_hours   REAL NOT NULL,
        familiarity  TEXT,
        usable_fraction REAL,
        rewrote      INTEGER,
        peer_comparison TEXT,
        created_at   INTEGER NOT NULL
      );
      CREATE INDEX idx_calibrations_category ON calibrations(category);

      CREATE TABLE day_metrics (
        day_key      TEXT NOT NULL,
        benchmark_version TEXT NOT NULL,
        mode         TEXT NOT NULL,
        payload      TEXT NOT NULL,
        computed_at  INTEGER NOT NULL,
        PRIMARY KEY (day_key, benchmark_version, mode)
      );

      CREATE TABLE parser_health (
        provider     TEXT NOT NULL,
        parser       TEXT NOT NULL,
        payload      TEXT NOT NULL,
        updated_at   INTEGER NOT NULL,
        PRIMARY KEY (provider, parser)
      );

      -- Every outbound network request, logged before and after it happens.
      CREATE TABLE external_requests (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        ts           INTEGER NOT NULL,
        provider     TEXT NOT NULL,
        endpoint     TEXT NOT NULL,
        purpose      TEXT NOT NULL,
        bytes_sent   INTEGER NOT NULL DEFAULT 0,
        redacted     INTEGER NOT NULL DEFAULT 1,
        status       TEXT NOT NULL,
        detail       TEXT
      );

      CREATE TABLE semantic_cache (
        key          TEXT PRIMARY KEY,
        payload      TEXT NOT NULL,
        model        TEXT NOT NULL,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE config (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );

      CREATE TABLE git_commits (
        repo_id      TEXT NOT NULL,
        sha          TEXT NOT NULL,
        ts           INTEGER NOT NULL,
        author_ts    INTEGER,
        subject_hash TEXT NOT NULL,
        files        INTEGER NOT NULL DEFAULT 0,
        insertions   INTEGER NOT NULL DEFAULT 0,
        deletions    INTEGER NOT NULL DEFAULT 0,
        is_revert    INTEGER NOT NULL DEFAULT 0,
        reverts_sha  TEXT,
        paths        TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (repo_id, sha)
      );
      CREATE INDEX idx_commits_ts ON git_commits(ts);
    `,
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;
