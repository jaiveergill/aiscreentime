# Leverage

**A personal AI engineering leverage tracker.** It reads your Claude Code and Codex
sessions, reconstructs the engineering tasks you actually completed, and estimates
how long each one would have taken a competent engineer working without AI.

> **27 conventional engineering hours**
> produced through agents today
> **53m steering · 30× output leverage**

It counts what survived, not what was generated. Everything runs locally.

---

## Install and run

Requires **Node 22.5+** (24+ recommended) — that is where `node:sqlite` landed.
Running from a source checkout instead of the published package needs **22.18+**,
for built-in type stripping. No other runtime, no database server, no account,
no API key.

```bash
npx @jaiveergill/leverage
```

That is the whole install. It scans your local Claude Code and Codex data, then
opens the dashboard.

To keep it around:

```bash
npm install -g @jaiveergill/leverage
leverage
```

From source:

```bash
git clone https://github.com/jaiveergill/leverage.git && cd leverage
npm install && npm run build && npm link
leverage
```

### Commands

| Command | What it does |
| --- | --- |
| `leverage` / `leverage start` | Scan local agent data, then open the dashboard |
| `leverage serve` | Dashboard only, no scan |
| `leverage ingest [--days N]` | Scan and update the index |
| `leverage today` | Today's summary in the terminal |
| `leverage day 2026-05-12` | A specific day |
| `leverage tasks [day]` | List reconstructed tasks |
| `leverage share <day> [--variant timeline] [--out card.svg]` | Write a share card |
| `leverage doctor` | Detected providers, parser health, watched paths |
| `leverage methodology` | The benchmark definition and its sources |
| `leverage demo` | Load a clearly-labelled synthetic dataset |
| `leverage reset [--all]` | Delete derived data (`--all` also deletes imported events) |

Useful flags: `--port`, `--json`, `--no-open`.

### No Claude Code or Codex installed?

`leverage demo` loads a synthetic dataset that is labelled as such everywhere it
appears. `leverage reset --all` removes it.

---

## What the number means

**Conventional engineering hours** = the estimated time a competent software
engineer would have needed to produce **the same accepted outcome** using a normal
development workflow, without generative-AI assistants or coding agents.

The comparison engineer has an IDE, a debugger, terminal tooling, documentation,
search engines, Stack Overflow, package managers, test frameworks, linters,
compilers, deterministic automation, and normal code review. They do not have
ChatGPT, Claude, Copilot, Cursor, Codex, AI-generated code, or autonomous agents.

This measures **modeled work output**. It is not a claim about wages, headcount,
economic value, or people replaced.

Full methodology, empirical anchors, and known failure modes: [docs/METHODOLOGY.md](docs/METHODOLOGY.md).

---

## How it works

```
  ~/.claude/projects/**/*.jsonl ─┐
                                 ├─→ collectors ─→ normalized events ─→ SQLite
  $CODEX_HOME/sessions/**/*.jsonl┘        │
                                          ├─→ task reconstruction
                                          ├─→ engineering-relevance gate
                                          ├─→ outcome verification (+ Git, read-only)
                                          ├─→ counterfactual estimation
                                          └─→ day metrics ─→ dashboard, share card
```

1. **Collect.** Provider-specific parsers turn transcripts into one canonical
   event model. Ingestion is incremental: unchanged files are not read at all.
2. **Reconstruct.** Sessions are split where the work demonstrably changed, then
   merged across sessions and providers when they share a repository and either
   several changed files or closely related instructions.
3. **Gate.** A segment must show positive evidence of software engineering before
   it becomes a task. Everything else is excluded and counted in **Data**.
4. **Verify.** Files on disk, tests after the last edit, commits, reverts,
   interruptions. Agent self-reports are evidence, never proof.
5. **Estimate.** A lognormal category prior adjusted by bounded, named factors,
   then scaled by completion and verification.
6. **Present.** Gross, accepted, and verified are never conflated. The headline
   uses verified.

Architecture and module boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Privacy

- **Everything is local.** No account, no API key, no cloud sync, no telemetry, no
  crash reporting. The database is a single SQLite file at `~/.leverage/leverage.db`.
- **Read-only.** Leverage never modifies, moves, or deletes a Claude Code, Codex,
  or Git file. Git access goes through one module with a read-only allowlist, and
  the linter enforces both rules.
- **Least privilege.** Only `~/.claude/projects` and `$CODEX_HOME/sessions` are
  read. Your home directory is not scanned.
- **Redaction at ingest.** Secrets, keys, and tokens are removed before anything
  is stored. Secret values are never stored, not even to prove they were found.
  This is best-effort and is labelled as such everywhere it appears.
- **Share cards are private by default.** No repository names, file paths,
  prompts, task titles, branch names, commit messages, or code. A preview lists
  exactly what will be exported.
- **Optional semantic analysis is off by default.** When enabled it sends only a
  category, integer counts, and a strict-redacted 600-character summary — never
  code, diffs, transcripts, paths, or repository names. Every outbound request is
  logged before and after it happens, and shown in **Data**.

Threat model: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

---

## Development

```bash
npm run build          # compile the server and bundle the dashboard
npm run dev            # rebuild the dashboard on change
npm run typecheck      # tsc --noEmit over src/ and src/ui/
npm run lint           # project invariants (see scripts/lint.mjs)
npm run format         # prettier
npm test               # unit + integration
npm run test:e2e       # API and evaluation fixture
npm run check          # format:check + lint + typecheck + all tests
```

Stress fixtures are generated at test time, never committed. Scale them with
`LEVERAGE_STRESS_SESSIONS` and `LEVERAGE_STRESS_RECORDS`.

### Adding a provider

Implement `Collector` in `src/collectors/types.ts` and register it in
`src/server/api.ts`. Emit `NormalizedEvent`s and nothing downstream changes —
no analytics, estimation, or UI code should ever need to know a provider exists.

---

## Known limitations

- Task boundaries are inferred. Two unrelated tasks in the same files may merge;
  one task spread across unrelated files may split. Both are correctable by hand.
- Steering time is modelled from observable interaction, not measured. Reading a
  diff for twenty minutes without touching anything is capped away.
- Category priors are anchored to a handful of studies, none of which measured
  your repository or your tasks. Calibration is the intended fix.
- Day-level ranges assume tasks are independent, which understates correlated
  uncertainty.
- Work done outside Claude Code and Codex is invisible.
- Redaction is pattern-based and cannot be complete.
