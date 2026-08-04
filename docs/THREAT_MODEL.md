# Threat model

Leverage reads some of the most sensitive material on a developer's machine:
complete transcripts of engineering work, including source code, credentials that
were pasted into prompts, customer names, and unreleased product plans.

This document states what it protects, what it does not, and how.

---

## Assets

| Asset | Where it lives | Sensitivity |
| --- | --- | --- |
| Agent transcripts | `~/.claude/projects`, `$CODEX_HOME/sessions` | Very high — code, secrets, plans |
| Source code and diffs | User repositories | Very high |
| Derived index | `~/.leverage/leverage.db` | High — redacted excerpts, paths, metadata |
| Task titles and instructions | The index | High — often name customers or products |
| Repository names and paths | The index | Medium — identify employer and clients |
| Aggregate metrics | The index | Low, but socially sensitive |
| Exported share cards | Wherever the user saves them | Whatever the user chose to include |

---

## Trust boundaries

```
   provider files ──read-only──▶ Leverage ──▶ ~/.leverage/leverage.db
                                    │
                                    ├──▶ 127.0.0.1 HTTP ──▶ the user's browser
                                    │
                                    └──▶ (opt-in only) an LLM API
                                         └─ redacted metadata, never code
```

Three boundaries matter:

1. **Filesystem.** What may be read, and what may never be written.
2. **Localhost HTTP.** What the browser can reach, and what other pages cannot.
3. **Network egress.** Off by default; when enabled, exactly what leaves.

---

## Adversaries and mitigations

### A1 — Leverage corrupts the agent's own data

*Impact: catastrophic. A productivity tracker that eats your Claude Code history
is worse than no tracker.*

- All provider access is `fs.createReadStream` / `readFileSync`. No write, move,
  delete, lock, or truncate call anywhere targets a provider path.
- All Git access is funnelled through `src/git/git.ts`, which allowlists
  `rev-parse, log, status, diff, show, ls-files, worktree list, config --get,
  cat-file, name-rev` and refuses anything else. `GIT_OPTIONAL_LOCKS=0` prevents
  index-lock contention with the user's own Git.
- `scripts/lint.mjs` fails the build if any file outside `git/git.ts` spawns
  `git`, or if any write call references a provider directory.
- The streaming reader never advances its cursor past a partial line, so a live
  agent appending to a transcript cannot cause a torn read.

**Residual risk:** none identified. This is the invariant most heavily enforced.

### A2 — Secrets leak from transcripts into the index

*Impact: high. Developers paste API keys into prompts constantly.*

- Redaction runs **at parse time**, before text reaches SQLite. Nothing
  unredacted is ever written.
- Detects private keys, AWS keys, Anthropic/OpenAI/GitHub/Slack/Google/Stripe/
  HuggingFace key shapes, JWTs, bearer tokens, database connection strings,
  `*_SECRET/*_TOKEN/*_PASSWORD` assignments, and quoted password literals.
- Secret values are **never stored**, not even to prove a redaction happened.
  Only a category label and a count are retained.
- Strict mode additionally removes emails, private hostnames, IP addresses, and
  the filesystem username.
- Stored text is length-capped, so a 4 MB command output cannot smuggle a key
  past the cap in its tail.

**Residual risk: real and acknowledged.** Pattern matching cannot recognise every
secret — a bare high-entropy string with no recognisable prefix will survive. The
product states this everywhere redaction is mentioned and never claims
completeness. Users handling especially sensitive material should exclude those
repositories entirely.

### A3 — Data leaves the machine unintentionally

*Impact: high.*

- There is no network code in the default path. No telemetry, no crash
  reporting, no update check, no analytics.
- The only outbound capability is the semantic layer, which is **off by default**
  and requires choosing a provider and supplying a key via environment variable.
- When enabled, the payload is built by `buildPrompt` from a whitelist: category,
  status, integer counts, a strict-redacted 600-character summary, and up to
  eight file **basenames**. Absolute paths are stripped outright rather than
  collapsed, because a directory path's basename *is* the repository name.
- Every request is written to `external_requests` **before** it is sent and
  updated after, with byte count and purpose. The **Data** view shows the log;
  when empty it says so explicitly.
- Results are cached by content hash, so re-analysis does not re-send.

**Residual risk:** a user who enables the layer trusts their chosen API provider
with task metadata. That is disclosed in the settings panel before enabling.

### A4 — A malicious web page drives the local API

*Impact: high — it could exfiltrate task titles and repository names.*

- The server binds to `127.0.0.1` only; it is not reachable from the network.
- Mutating requests with a cross-origin `Origin` header are rejected with 403.
- The dashboard ships `default-src 'none'` with no external hosts permitted, so a
  compromised dependency could not phone home. There are no runtime dependencies
  to compromise.
- `x-content-type-options: nosniff` and `referrer-policy: no-referrer` on every
  response.

**Residual risk:** any local process running as the user can read the SQLite file
directly. Leverage does not defend against a compromised local account — that is
outside any single-user tool's reach.

### A5 — Prompt injection via transcript content

*Impact: medium.*

Transcripts contain arbitrary text, including text an attacker may have planted
in a repository the user asked an agent to read.

- Parsed text is **data, never instructions**. Nothing in the pipeline executes,
  evaluates, or dispatches on transcript content.
- Rendering builds DOM nodes with `document.createTextNode`; the dashboard never
  assigns untrusted content to `innerHTML`.
- SVG cards XML-escape every interpolated value. A repository named
  `</text><script>` renders as text, and there is a test for it.
- Transcript text reaching the semantic layer is redacted and length-capped, and
  the model's reply is validated and clamped — a reply claiming a 100× complexity
  multiplier is clamped to 1.6.

### A6 — A user inflates their own numbers

*Impact: reputational — for the product, not the user.*

The product cannot stop someone lying, but it must not help:

- Token counts, tool calls, agent runtime, and prompt counts are **not** inputs
  to any estimate.
- Diff size is heavily sublinear: 100× the lines yields under 3× the estimate.
- Generated, vendored, and lockfile paths are excluded from authored line counts.
- Per-path line contributions are capped, so rewriting one file repeatedly cannot
  manufacture a large diff.
- Failed, reverted, and superseded work is discounted to near zero.
- Estimates above 12 hours with weak evidence are heavily discounted, flagged,
  and have their confidence cut.
- Share cards always use conservative mode.
- User-edited estimates are labelled as edited wherever they appear, including in
  exports, and every override is retained as an audit trail.

### A7 — Reading beyond the user's intent

*Impact: medium — a privacy violation even without a leak.*

- Only `~/.claude/projects` and `$CODEX_HOME/sessions` are enumerated. The home
  directory is never walked.
- Repository resolution walks *up* from a session's own `cwd` and stops at a
  filesystem root or an allowed-root boundary. It never walks down into
  unrelated trees.
- The repo size estimate is capped at 20,000 files and skips `node_modules`,
  `.git`, build outputs, and virtualenvs.
- The exact directory list is shown during onboarding **before** the first scan
  and permanently in **Data**.
- Any repository can be excluded, which removes its work from every total and
  recomputes immediately.

### A8 — Stale or misleading numbers after a change

*Impact: medium — a trust failure.*

- Every estimate and day metric records its `BENCHMARK_VERSION`. Historical
  results are not silently rewritten when the model changes.
- Changing a scope setting (repositories, sessions, categories, providers,
  redaction, timezone) invalidates and recomputes the affected window — including
  the case where the change removes *every* event, which must still clear the
  stale rows rather than leaving the old numbers on screen.
- Every prominent number carries an epistemic tag, so an estimate is never
  mistaken for a measurement.

---

## What Leverage explicitly does not defend against

- A compromised user account or a malicious local process.
- Disk-level compromise. The database is not encrypted; it inherits the
  filesystem's protections.
- Full-disk backups that include `~/.leverage/leverage.db`.
- A user deliberately misrepresenting their own output.
- Complete secret redaction. It is best-effort, always.

---

## User controls

| Control | Where |
| --- | --- |
| Disable a provider | Settings → Collection |
| Exclude a repository | Settings → Repositories |
| Exclude a session or category | Settings, or per-task |
| Pause all collection | Settings → Scope |
| Redaction level and custom terms | Settings → Privacy |
| Inspect everything stored | Settings → Your data, Data view |
| See every outbound request | Data → Outbound network requests |
| Enable/disable semantic analysis, choose a local model | Settings → Semantic analysis |
| Set retention and delete old events | Settings → Your data |
| Delete derived data / delete everything | Settings → Your data |
| Export your own derived data | Settings → Your data |
