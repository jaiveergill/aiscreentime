# Architecture

## Why this shape

The requirements that decided it:

- **Local-first, private by construction.** No cloud, no account, no telemetry.
- **Excellent local-file access.** Two providers, hundreds of megabytes, formats
  that change between versions.
- **Simple installation.** A developer should be running it in under a minute.
- **Low memory, fast incremental updates.** Some users have gigabytes of history.
- **Polished visual design and local share-card export.**
- **Cross-platform potential.**

**Chosen: a Node CLI that ingests into SQLite and serves a local dashboard.**

- **Node 22.18+ with built-in type stripping.** TypeScript runs directly from
  source, so `npx`-style use needs no build step, while `npm run build` produces
  a compiled `dist/` for distribution.
- **`node:sqlite`**, built into Node. No native module, no compile step, no
  `better-sqlite3` install failures — the single biggest cause of "it didn't
  install" for local developer tools.
- **Zero runtime dependencies.** `esbuild`, `typescript`, and `prettier` are
  dev-only. The shipped product depends on Node and nothing else.
- **Vanilla TypeScript dashboard, 57 KB bundled.** A framework would add weight
  and indirection for a handful of views over data that changes only when the
  user acts. It also lets the server ship `default-src 'none'` as its CSP.

**Rejected:** Electron and Tauri (heavy install, or a Rust toolchain, for what is
fundamentally a file reader with a chart); a cloud backend (contradicts the
privacy promise); a headless-browser renderer for share cards (a large dependency
to draw a rectangle — SVG plus canvas is enough).

---

## Module boundaries

```
src/
  core/         types, util, config, logging          — no dependencies on anything below
  privacy/      redaction, secret detection           — used at ingest, before storage
  collectors/   provider discovery + parsers          — the ONLY provider-aware code
    claude/     Claude Code JSONL (v2.1.x)
    codex/      Codex rollouts (0.108–0.146)
    jsonl.ts    streaming reader with byte cursors
  normalize/    command + path classification         — provider-neutral
  ingest/       incremental engine, cursors, dedupe
  repo/         repository + worktree resolution
  git/          read-only Git, single choke point
  tasks/        segmentation, merging, relevance, categorisation
  verify/       outcome verification
  estimate/     priors (versioned) + lognormal model
  steering/     steering time, agent runtime, concurrency
  calibration/  personal baseline learning
  semantic/     optional LLM layer behind an interface
  analytics/    pipeline (derive) + metrics (aggregate)
  share/        SVG card rendering
  server/       HTTP + API
  demo/         synthetic evaluation fixture
  cli/          command-line interface
  ui/           dashboard (bundled separately)
```

The rule that keeps this honest: **`collectors/` is the only place that knows a
provider exists.** Everything downstream speaks `NormalizedEvent`. Adding a
provider means writing one `Collector` and registering it; no analytics,
estimation, or UI code changes.

The second rule: **`git/git.ts` is the only place that spawns `git`**, and it
enforces a subcommand allowlist. `scripts/lint.mjs` fails the build if either
rule is violated, or if anything writes to a provider directory.

---

## Data flow

```
discover ─→ cursor check ─→ stream parse ─→ redact ─→ normalize ─→ SQLite(events)
                                                                        │
                                                    ┌───────────────────┘
                                                    ▼
              segment → merge → relevance gate → evidence → verify → estimate
                                                                        │
                                              SQLite(tasks, estimates)  │
                                                                        ▼
                                                    day metrics → API → dashboard
                                                                     └→ SVG card
```

`events` is the source of truth. Everything else — tasks, estimates, day metrics —
is derived and can be dropped and rebuilt at any time. The only state that cannot
be regenerated is user-owned: `task_overrides` and `calibrations`.

---

## Incremental ingestion

Each transcript has a cursor: `(bytes_consumed, lines_consumed, head_fingerprint,
size, mtime)`.

| Situation | Action |
| --- | --- |
| size and mtime unchanged | Skip entirely — the file is not opened |
| grown, head fingerprint matches | Parse only the appended bytes |
| shrunk, or head changed | Truncated/rotated/rewritten: reset cursor, re-parse |
| missing | Mark `missing`, keep its events |

The streaming reader never yields a partial trailing line and never advances the
cursor past one, so a live agent appending to a file cannot cause a torn read.
Memory is bounded by a 1 MB read buffer plus the longest single line.

Re-parsing is safe because event ids are content-addressed over
`(provider, file, line, kind, call id)`. Re-ingesting collides on primary key and
is ignored, so a full re-parse after a rewrite is idempotent.

---

## Handling schema drift

Provider formats are undocumented implementation details that change between
releases. The defences:

1. **Tolerate unknown records.** Unrecognised types are counted in
   `unknownTypes` and skipped. Never fatal.
2. **Tolerate malformed records.** Unparsable lines increment `recordsMalformed`
   and parsing continues.
3. **Tolerate missing fields.** Every field access goes through `asString` /
   `asNumber` / `isRecord` helpers that return `undefined` rather than throwing.
   A record with no usable timestamp is skipped, not dated to the epoch.
4. **Reconcile duplicate representations.** Codex records shell execution as a
   rich `event_msg/exec_command_end` in newer builds and as a bare
   `response_item/function_call` in older ones. Both are parsed and reconciled by
   call id at end of file, with the richer form winning. Neither version loses
   data and no version double-counts.
5. **Surface everything.** Parser health — events emitted, records ignored,
   malformed, duplicate, replayed, and every unknown type with its count — is
   persisted and shown in **Data**.

---

## Storage

One SQLite file, WAL mode, at `~/.screentime/screentime.db` (override with
`SCREENTIME_HOME`).

| Table | Regenerable | Purpose |
| --- | --- | --- |
| `sources` | no* | Ingestion cursors |
| `events` | no* | Canonical events with full provenance |
| `sessions` | yes | Session bounds and metadata |
| `repos` | yes | Discovered projects |
| `tasks` | yes | Reconstructed tasks |
| `task_events` | yes | Task ↔ event membership |
| `estimates` | yes | Per task, per benchmark version |
| `day_metrics` | yes | Cached day aggregates |
| `task_overrides` | **user-owned** | Corrections |
| `calibrations` | **user-owned** | Personal baseline |
| `semantic_cache` | yes | LLM results, cached by content hash |
| `parser_health` | yes | Collector diagnostics |
| `external_requests` | audit | Every outbound request, before and after |
| `git_commits` | yes | Correlated commit metadata |

\* regenerable from the provider files, if they still exist.

Migrations are append-only and applied in a transaction. Migrations touching
`events`, `sources`, `task_overrides`, or `calibrations` must preserve data;
everything else may be dropped and rebuilt.

---

## Concurrency and lifecycle

The CLI is a single process. Ingestion is sequential and cancellable via
`AbortSignal`; a cancelled run leaves valid cursors, so the next run resumes
exactly where it stopped. WAL mode lets the dashboard read while ingestion writes.

The server binds to `127.0.0.1` only. There is no authentication because there is
no remote surface; a same-origin check on mutating requests prevents a web page
in the user's browser from driving the API cross-site.

---

## Testing strategy

| Suite | What it covers |
| --- | --- |
| `test/unit/collectors` | Discovery, parsing, schema drift, malformed input, streaming, compaction, resumed sessions |
| `test/unit/analytics` | Intervals, classification, steering, concurrency, reconstruction, relevance, categorisation, verification, the lognormal model, repo resolution |
| `test/unit/privacy` | Redaction, the semantic egress boundary, share-card privacy |
| `test/integration/ingest` | Migrations, incremental ingestion, truncation, interruption recovery, the full pipeline, calibration |
| `test/integration/performance` | Generated corpora, throughput, memory bounds, huge lines, malformed corpora |
| `test/e2e/api` | Every endpoint, HTTP transport, CSRF, path traversal |
| `test/e2e/fixture` | The evaluation fixture with explicit expected outcomes |

The evaluation fixture asserts **orderings and bounds**, not exact numbers, so the
model can improve without rewriting the suite — and so nobody is tempted to tune
until the total looks impressive.
