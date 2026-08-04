# Methodology

Benchmark version **v1.0.0**.

Every number Leverage shows is tagged with what kind of number it is:

| Tag | Meaning |
| --- | --- |
| **measured** | Read directly from a provider file or the filesystem. No inference. |
| **derived** | Computed deterministically from measured values. |
| **inferred** | Produced by a heuristic over the available evidence. |
| **estimated** | Produced by the counterfactual model. Carries a distribution. |
| **user-corrected** | Set or overridden by you. Always wins, always labelled. |

---

## 1. The benchmark

> **Counterfactual conventional engineering time** is the time a competent
> software engineer would have needed to produce the same accepted outcome using
> a normal software-development workflow, without generative-AI assistants or
> coding agents.

The comparison engineer **may use**: a modern IDE, terminal tools, debuggers,
documentation, search engines, Stack Overflow, package managers, test frameworks,
linters, compilers, existing scripts and deterministic automation, and normal
collaboration and code-review tooling.

They **may not use**: ChatGPT, Claude, Copilot, Cursor, Codex, AI-generated code,
autonomous coding agents, or generative-AI research and debugging assistance.

This is not "working like it is 1995". It is a counterfactual workflow,
approximately representative of competent development before generative coding
tools became normal.

It measures **modeled work output**. It is not a claim about wages, headcount,
economic value, or people replaced.

---

## 2. Where the leverage actually comes from

This matters, because the honest reading of the literature does not support a
large per-task speedup.

- **METR (arXiv:2507.09089, July 2025).** 16 experienced open-source developers,
  246 real tasks in repositories they knew well. Developers were **19% slower**
  with early-2025 AI tools. A 2026 follow-up estimated roughly +18% but the
  authors flagged selection effects and revised the design.
- **GitHub / Accenture (n=95, 2024).** One standardised greenfield task. Control
  group 2h41m, assisted group 1h11m — **55.8% faster**, 95% CI [21%, 89%].

So the credible range for *interactive assistance on one task* is somewhere
between meaningfully slower and roughly twice as fast. Nothing in that range
produces a 27× headline.

Leverage therefore applies **no per-task speedup multiplier at all.** Each task is
estimated on its own evidence, as if a conventional engineer had been asked to
produce that same outcome. The multiplier is an *output* of the accounting, and it
emerges from three things:

1. **Task count.** Directing agents lets a person attempt far more discrete
   pieces of work in a day than they could personally implement.
2. **Concurrency.** Several agents work simultaneously against one steerer.
3. **Delegation of the long tail.** Work that would otherwise not be done at all —
   the test suite nobody had time for, the doc nobody wrote.

If your leverage number is large, it is because you completed and verified many
tasks while steering for a few hours — not because a knob was set to 27.

---

## 3. Effort is lognormal

Software effort is consistently found to be right-skewed and approximately
lognormal: most tasks land near the median, a minority take far longer, and none
take negative time. Reported coefficient of variation of developer productivity
averages ~0.55, with the top half of developers roughly 2.44× the bottom half.

So every estimate is a lognormal distribution, not a point:

- `median` — the central estimate
- `p10` / `p90` — the reported range
- `sigma` — how genuinely unpredictable this category is

Sigma is floored at 0.45. No estimate is allowed to claim more precision than the
evidence supports. Debugging carries the widest sigma (0.90) because the same
symptom can resolve in ten minutes or consume a day; documentation carries one of
the tightest (0.50).

Day totals sum the per-task distributions using a Fenton–Wilkinson moment match.
This is exact for the mean and assumes independence across tasks, which
understates correlated uncertainty — a known limitation, and the reason day-level
ranges are presented as approximate.

---

## 4. Category priors

Each category has a median and a sigma for a *typical* task of that kind, in a
codebase the engineer works in regularly. Full table with per-category rationale:
`leverage methodology`, or the **Method** tab in the dashboard.

Anchoring:

- **feature-greenfield (2.7 h)** is taken directly from the GitHub control-group
  time for building a self-contained feature from scratch.
- **feature-brownfield (3.2 h)** scales up from METR's ~2 hour issue-sized unit,
  because a feature spans several such units plus the cost of understanding the
  surrounding code.
- Everything else is positioned relative to those two using the relative effort
  ordering the estimation literature agrees on, with sigma set by how
  heavy-tailed the category is in practice.

These are starting distributions. They are deliberately conservative, they are
not measurements of *your* work, and they are meant to be displaced by your own
calibration data.

---

## 5. Task reconstruction

Raw sessions are not tasks.

**Segment.** Within a session, a new segment starts when either:
- the idle gap exceeds 45 minutes, or
- a new instruction is lexically unrelated to the segment so far **and** the work
  that follows it touches a disjoint set of files.

Both conditions are required. That is what keeps a correction ("the expiry check
is inverted") attached to the task it corrects — a correction is lexically
unrelated but lands in the same files.

**Merge.** Segments across sessions and providers are merged when they share a
repository and satisfy either:
- **≥2 shared changed files** with ≥34% overlap, or
- **≥1 shared file** with ≥40% overlap *and* ≥0.15 instruction containment.

The two-file threshold matters: hub files like `app.py` or `index.ts` are touched
by nearly every change in a project, and a single shared file is not evidence
that two pieces of work are the same task.

Containment (how much of the *shorter* instruction's vocabulary appears in the
longer one) is used rather than Jaccard, because a follow-up instruction is much
shorter than the original ask and Jaccard would dilute the match.

Every grouping decision is recorded and shown in the task's **Evidence** tab.

---

## 6. The engineering-relevance gate

Coding agents are general assistants. Real transcripts contain plenty of work that
is not software engineering: drafting emails, answering questions, summarising a
page, chatting. None of that has a counterfactual *engineering* time, and
crediting it would turn the headline into a vanity metric.

A segment must score ≥4 on structural evidence to become a task:

| Evidence | Points |
| --- | --- |
| Source files changed | 5 |
| Test / build / lint run | 4 |
| ≥3 shell commands | 3 |
| Non-source files changed | 2 |
| ≥2 source files read | 2 |
| ≥5 engineering tool calls | 2 |
| Work inside a Git repository | 2 |
| Instruction contains code | 2 |
| Instruction uses engineering vocabulary | 1 |

Technical vocabulary alone is never sufficient. The gate is deliberately strict:
wrongly excluding a small task costs a slightly lower number; wrongly including
chat costs a number nobody should believe.

Rejected segments are counted and shown in **Data** — never silently dropped.

---

## 7. Steering time

A person is modelled as present in bounded windows around each observable action:

1. **Compose** — before each instruction, they were typing it. Capped, and
   further bounded by the gap since the previous event in that session.
2. **Tail** — immediately after acting, they are still at the keyboard.
3. **Read** — after a turn ends, someone reads the result. Bounded by the gap to
   the next human action, and capped: if the next action is four hours later,
   they were not reading for four hours.

These windows are then **unioned across all sessions**. That union is what
structurally prevents four concurrent agents from producing four hours of human
time in one hour.

Not counted: unattended agent execution, idle terminals, the whole span between
first and last prompt, time the user is absent, background processes.

The caps *are* the model, so three parameterisations are computed and a range is
shown:

| | Compose | Read | Tail |
| --- | --- | --- | --- |
| Low | 60 s | 45 s | 20 s |
| Balanced | 150 s | 120 s | 45 s |
| High | 300 s | 240 s | 90 s |

---

## 8. Agent runtime and concurrency

Turn durations are used **verbatim** where providers report them — Claude Code's
`system/turn_duration.durationMs` and Codex's `event_msg/task_complete.duration_ms`
are measured, not inferred. Where absent, a turn is bridged from an instruction to
the next turn-ending event, capped at 30 minutes so an abandoned session does not
report a nine-hour runtime.

Two quantities are reported separately and never conflated:

- **Total agent time** — compute summed across workers. Can exceed the day.
- **Wall-clock agent time** — the union. Can never exceed elapsed time.

Reporting only the first would be dishonest; only the second would erase the
parallelism that is the entire point.

---

## 9. Outcome verification

Status is decided from evidence, in this order:

| Status | Trigger | Completion | Verification |
| --- | --- | --- | --- |
| `reverted` | Revert commit, or created-then-deleted in-task | 0.00 | 0.00 |
| `exploratory` | No files changed, but real investigation | 1.00 | 0.60 |
| `failed` | Files changed, none survive | 0.15 | 0.30 |
| `partial` | Verification failing after the last edit | 0.50 | 0.55 |
| `abandoned` | Unresolved errors plus interruption | 0.10 | 0.25 |
| `completed-validated` | Tests passed *after* the last edit | 1.00 | 0.85–1.00 |
| `completed-weak-validation` | Files persist, weaker signals | 1.00 | 0.70 |
| `unknown` | Insufficient evidence | 0.50 | 0.45 |

Rules that matter:

- A test that passed **before** the last edit does not validate that edit.
- An agent's completion summary is evidence, never proof. It can never on its own
  produce `completed-validated`.
- Partial persistence scales completion continuously, not in steps.
- Human edits to the same files mark attribution ambiguous and discount the
  result by 15%.
- If the project directory is unreachable, file persistence is **not** checked —
  absence proves nothing about a tree that no longer exists.

---

## 10. Estimation

```
gross     = categoryPrior.median × Π(bounded factors) × modeMultiplier
accepted  = gross    × completionFactor
verified  = accepted × verificationFactor      ← the headline
```

Factors, all bounded and all shown in the task view with their rationale:

| Factor | Range | Driven by |
| --- | --- | --- |
| Scope | 0.55–2.6 | log₂(files changed) |
| Cross-subsystem | 1.0–1.45 | log₂(subsystems) |
| Code volume | 0.6–2.2 | log₂(non-generated lines) |
| Debugging depth | 1.0–1.55 | errors, capped by distinct commands |
| Verification work | 1.0–1.30 | test/build/lint/typecheck runs |
| Repository maturity | 0.88–1.35 | log₁₀(repo file count) |
| Polyglot | 1.0–1.25 | distinct languages |
| Migration risk | 1.25 | migration-shaped paths |
| Infrastructure risk | 1.15 | deploy-shaped paths |
| Ambiguity | 1.0–1.28 | log₂(instruction rounds) |
| Research depth | 0.25–1.5 | investigative actions (exploration only) |
| Boilerplate | 0.45–1.0 | scaffolding shape — a **discount** |
| Semantic | 0.6–1.6 | optional LLM layer |
| Calibration | 0.4–2.5 | your own data, shrunk |
| Mode | 0.8 / 1.0 / 1.25 | conservative / balanced / upper-range |

**Never used as multipliers:** tokens, tool calls, agent runtime, prompt count,
file count taken linearly. Size appears only as a heavily sublinear complexity
signal — 100× the lines yields under 3× the estimate, because the relationship
between diff size and engineering effort is weak and trivially gameable.

### Anti-gaming

- Generated, vendored, and lockfile paths are excluded from authored line counts.
- Per-path line contribution is capped, so rewriting one file 60 times cannot
  manufacture a large diff.
- Editing one file eleven times is one changed file.
- Many errors with few distinct commands reads as an agent loop, not difficulty,
  and the difficulty credit is capped.
- Estimates above 12 hours with weak evidence are heavily discounted and flagged,
  and confidence is reduced by 35%.
- Failed, reverted, and superseded work is discounted to near zero.
- Share cards always use conservative mode.
- User-edited estimates are labelled everywhere they appear.

---

## 11. Confidence

Confidence blends evidence strength, category certainty, and distribution width:

```
score = 0.55·evidenceStrength + 0.25·categoryConfidence + 0.20·(1 − widthPenalty)
```

with a bonus for accumulated calibration and a 35% penalty when the extreme-value
guard engaged. `high ≥ 0.68`, `medium ≥ 0.42`, otherwise `low`.

Category confidence itself blends **how much** evidence there is with **how
cleanly** it points at one category. Margin alone would be wrong: a single weak
signal has a perfect margin but tells you almost nothing.

---

## 12. Calibration

When you answer "how long would this actually have taken you?", Leverage learns a
per-category ratio between your answer and the standardised estimate.

Two rules keep this honest:

1. A correction calibrates **your** model, never the shared prior. The
   standardised competent-engineer view and the personalised view are stored and
   displayed separately and are never silently blended.
2. The learned multiplier is a **shrunk geometric mean**: `exp(log(ratio) ·
   n/(n+4))`. One data point moves it 20% of the way; it approaches the observed
   ratio only as evidence accumulates. Geometric because the underlying quantity
   is lognormal — averaging ratios arithmetically would bias upward.

---

## 13. Versioning

Every estimate and day metric records the benchmark version it was computed
under. Historical results are not silently rewritten when the model changes:
bumping `BENCHMARK_VERSION` writes to new rows, and the version is displayed
alongside every headline.

---

## 14. Known failure modes

- **Task boundaries are inferred.** Two unrelated tasks in the same files may
  merge; one task spread across unrelated files may split.
- **Steering time is modelled, not measured.** Reading a diff for twenty minutes
  without touching anything is capped away. Long silent thinking is invisible.
- **Priors are thin.** They rest on a handful of studies, none of which measured
  your repository, your tasks, or agent-delegated work.
- **Day ranges assume independence** across tasks, understating correlated
  uncertainty.
- **Attribution is ambiguous** when you and an agent edit the same files. Those
  tasks are discounted, not excluded.
- **Work outside Claude Code and Codex is invisible**, including your own manual
  implementation.
- **The relevance gate is strict** and will exclude genuinely small engineering
  tasks that left almost no trace.
- **Redaction is pattern-based** and cannot be complete.
- **Commands are classified by pattern.** A test runner invoked through an
  unusual wrapper will be missed, which understates verification.
