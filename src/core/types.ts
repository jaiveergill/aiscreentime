/**
 * Canonical, provider-neutral domain model.
 *
 * Everything downstream of the collectors speaks this vocabulary. Adding a new
 * agent provider means writing a collector that emits `NormalizedEvent`s; no
 * analytics, estimation, or UI code should ever need to change.
 *
 * Provenance is mandatory: every normalized event can be traced back to the
 * exact provider, file, and byte range it came from.
 */

// ---------------------------------------------------------------------------
// Provenance & epistemics
// ---------------------------------------------------------------------------

/** Identifier of a data source implementation. Extensible by design. */
export type ProviderId = 'claude-code' | 'codex' | 'demo' | (string & {});

/**
 * How much epistemic weight a number carries. Every prominent figure in the UI
 * must be tagged with one of these — this is a product requirement, not a
 * decoration.
 */
export type Epistemics =
  /** Read directly out of a provider file or the filesystem. No inference. */
  | 'measured'
  /** Deterministically computed from measured values (sums, diffs, ratios). */
  | 'derived'
  /** Produced by a heuristic over measured/derived evidence. */
  | 'inferred'
  /** Produced by the counterfactual estimation model. Carries a distribution. */
  | 'estimated'
  /** Supplied or overridden by the user. Always wins, always labelled. */
  | 'user-corrected';

/** Points at the exact raw record a normalized event was derived from. */
export interface Provenance {
  readonly provider: ProviderId;
  /** Absolute path of the source file at ingestion time. */
  readonly sourceFile: string;
  /** 0-based line index within the JSONL file. */
  readonly lineIndex: number;
  /** Byte offset of the start of the line. Enables exact re-reads. */
  readonly byteOffset: number;
  /** Parser implementation that produced this event, e.g. `claude-code/v2`. */
  readonly parser: string;
  /** Provider-reported schema/CLI version, when present. */
  readonly providerVersion?: string;
}

// ---------------------------------------------------------------------------
// Normalized events
// ---------------------------------------------------------------------------

export type EventKind =
  // session lifecycle
  | 'session.started'
  | 'session.resumed'
  | 'session.forked'
  | 'session.ended'
  | 'session.compacted'
  // conversation
  | 'user.instruction'
  | 'assistant.message'
  | 'assistant.reasoning'
  | 'user.interrupt'
  // tools
  | 'tool.invoked'
  | 'tool.result'
  | 'shell.command'
  | 'file.read'
  | 'file.created'
  | 'file.modified'
  | 'file.deleted'
  | 'search.performed'
  | 'web.fetched'
  // engineering signals
  | 'test.run'
  | 'build.run'
  | 'lint.run'
  | 'typecheck.run'
  | 'error.encountered'
  // control
  | 'approval.requested'
  | 'approval.granted'
  | 'approval.denied'
  | 'agent.retry'
  | 'subagent.spawned'
  | 'subagent.completed'
  // accounting
  | 'tokens.reported'
  | 'turn.completed'
  // repository
  | 'git.observed'
  | 'git.commit'
  | 'git.branch'
  | 'verification.result'
  // escape hatch — always preserved, never silently dropped
  | 'unknown';

/** Verdict of an executed command that we could classify. */
export type ExecOutcome = 'pass' | 'fail' | 'unknown';

/** File mutation recorded by a provider, with enough shape to size the change. */
export interface FileChange {
  readonly path: string;
  readonly changeType: 'add' | 'update' | 'delete' | 'rename';
  readonly linesAdded: number;
  readonly linesRemoved: number;
  /** True when the path matches generated/vendored/lockfile heuristics. */
  readonly generated: boolean;
  /** True when the provider indicated the file is binary or unreadable as text. */
  readonly binary: boolean;
}

/**
 * Structured payload. Deliberately a flat optional bag rather than a
 * discriminated union: providers disagree about which fields exist, and
 * tolerating absence is a hard requirement.
 */
export interface EventPayload {
  /** Redacted, length-capped text. Never raw secrets. */
  readonly text?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly durationMs?: number;
  readonly outcome?: ExecOutcome;
  readonly files?: readonly FileChange[];
  readonly paths?: readonly string[];
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly tokensCacheRead?: number;
  readonly tokensCacheWrite?: number;
  readonly model?: string;
  readonly subagentId?: string;
  readonly subagentLabel?: string;
  readonly branch?: string;
  readonly commitHash?: string;
  readonly repositoryUrl?: string;
  /** Reason string for interrupts, aborts, denials. */
  readonly reason?: string;
  /** Original provider-specific type, retained for the collector-debug view. */
  readonly rawType?: string;
  /** Counters for compaction bookkeeping. */
  readonly droppedTokens?: number;
}

export interface NormalizedEvent {
  /** Stable content-addressed id. Identical raw records dedupe to one event. */
  readonly id: string;
  readonly sessionId: string;
  readonly provider: ProviderId;
  readonly kind: EventKind;
  /** Epoch milliseconds, UTC. */
  readonly ts: number;
  /**
   * Original timestamp string exactly as the provider wrote it, so we never
   * lose sub-millisecond or timezone precision we cannot represent in `ts`.
   */
  readonly tsRaw?: string;
  /** Working directory in effect for this event, when the provider records it. */
  readonly cwd?: string;
  /** Resolved repository id, filled in by the repo-resolution stage. */
  readonly repoId?: string;
  /** Turn grouping id when the provider exposes one. */
  readonly turnId?: string;
  /** True when this event belongs to a subagent rather than the main thread. */
  readonly isSubagent: boolean;
  /**
   * True when this record is replayed history (compaction replacement, resumed
   * transcript prefix). Retained for evidence but excluded from all counting.
   */
  readonly isReplay: boolean;
  readonly payload: EventPayload;
  readonly provenance: Provenance;
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export interface RepoRecord {
  readonly repoId: string;
  /** Canonical absolute path of the repository root (main worktree). */
  readonly root: string;
  /** Display name; may be aliased for sharing. */
  readonly name: string;
  readonly isGit: boolean;
  /** Path is a linked worktree of `mainRoot`. */
  readonly worktreeOf?: string;
  readonly remoteUrlHash?: string;
  /** Rough size signal used as an estimation context factor. */
  readonly fileCount?: number;
  readonly included: boolean;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export type TaskCategory =
  | 'feature-greenfield'
  | 'feature-brownfield'
  | 'debugging'
  | 'incident-investigation'
  | 'refactoring'
  | 'migration'
  | 'testing'
  | 'code-review'
  | 'research'
  | 'documentation'
  | 'project-setup'
  | 'dependency-tooling'
  | 'infrastructure'
  | 'data-analysis'
  | 'performance'
  | 'security'
  | 'design-architecture'
  | 'maintenance'
  | 'failed-exploration';

export type TaskStatus =
  | 'completed-validated'
  | 'completed-weak-validation'
  | 'partial'
  | 'exploratory'
  | 'failed'
  | 'abandoned'
  | 'reverted'
  | 'superseded'
  | 'unknown';

/** How much of a task's estimated value is creditable, by status. */
export interface TaskEvidence {
  readonly filesChanged: number;
  readonly filesAdded: number;
  readonly filesDeleted: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly generatedLinesAdded: number;
  readonly subsystemsTouched: number;
  readonly testsRun: number;
  readonly testsPassed: number;
  readonly testsFailed: number;
  readonly buildsRun: number;
  readonly buildsPassed: number;
  readonly lintRuns: number;
  readonly typecheckRuns: number;
  readonly errorsEncountered: number;
  readonly commits: number;
  readonly revertedCommits: number;
  readonly humanInterrupts: number;
  readonly userInstructions: number;
  readonly retries: number;
  readonly subagentCount: number;
  readonly toolCalls: number;
  readonly distinctCommands: number;
  readonly researchArtifacts: number;
  readonly filesStillPresent: number;
  readonly filesMissing: number;
  /**
   * Tokens the model was fed across this task's turns, cache included.
   *
   * Normalised by the collectors: the two providers report cached input on
   * opposite conventions, so the raw fields are not comparable.
   */
  readonly tokensIn: number;
  /** Tokens generated, reasoning included where the provider reports it. */
  readonly tokensOut: number;
  /** The portion of `tokensIn` that was served from cache rather than re-read. */
  readonly tokensCacheRead: number;
}

export interface TaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly intent: string;
  readonly category: TaskCategory;
  readonly categorySource: Epistemics;
  readonly status: TaskStatus;
  readonly statusSource: Epistemics;
  readonly repoId?: string;
  readonly startedAt: number;
  readonly endedAt: number;
  /** Sessions contributing to this task, in first-contribution order. */
  readonly sessionIds: readonly string[];
  readonly providers: readonly ProviderId[];
  readonly evidence: TaskEvidence;
  /** Wall-clock span of the task, ms. */
  readonly wallClockMs: number;
  /** Agent-active runtime attributed to this task, ms. */
  readonly agentActiveMs: number;
  /** Human steering time attributed to this task, ms. */
  readonly steeringMs: number;
  readonly excluded: boolean;
  readonly userEdited: boolean;
  /** Task this one supersedes or was merged from. */
  readonly mergedFrom?: readonly string[];
  readonly relatedTaskIds?: readonly string[];
  readonly dayKey: string;
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

/**
 * A lognormal effort distribution. Chosen because the empirical literature
 * consistently finds software task effort to be approximately lognormal
 * (see docs/METHODOLOGY.md).
 */
export interface EffortDistribution {
  /** exp(mu) — the median, in hours. */
  readonly median: number;
  /** sigma of the underlying normal, in log space. */
  readonly sigma: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  /** Expected value, exp(mu + sigma^2/2). */
  readonly mean: number;
}

export interface EstimationFactor {
  readonly key: string;
  readonly label: string;
  /** Multiplicative adjustment applied to the median. */
  readonly multiplier: number;
  readonly rationale: string;
  readonly epistemics: Epistemics;
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

export interface TaskEstimate {
  readonly taskId: string;
  readonly benchmarkVersion: string;
  /** Effort a competent engineer would need for the *full intended* outcome. */
  readonly gross: EffortDistribution;
  /** Gross scaled by completion — what was actually produced. */
  readonly accepted: EffortDistribution;
  /** Accepted scaled by verification strength — the headline number. */
  readonly verified: EffortDistribution;
  readonly completionFactor: number;
  readonly verificationFactor: number;
  readonly reuseFactor: number;
  readonly factors: readonly EstimationFactor[];
  readonly confidence: ConfidenceLevel;
  readonly confidenceScore: number;
  readonly uncertaintyNotes: readonly string[];
  readonly priorId: string;
  readonly calibrated: boolean;
  readonly userOverrideHours?: number;
  readonly semanticUsed: boolean;
  readonly computedAt: number;
}

// ---------------------------------------------------------------------------
// Daily analytics
// ---------------------------------------------------------------------------

export interface DayMetrics {
  /**
   * Shape version of this cached payload. A mismatch makes the cache a miss,
   * so a schema change can never serve a half-populated object to the UI.
   */
  readonly shapeVersion: number;
  readonly dayKey: string;
  readonly benchmarkVersion: string;
  readonly verifiedHours: EffortDistribution;
  readonly acceptedHours: EffortDistribution;
  readonly grossHours: EffortDistribution;
  readonly steeringMs: number;
  readonly steeringLowMs: number;
  readonly steeringHighMs: number;
  /**
   * Time spent writing instructions. A strict subset of `steeringMs`, which
   * also includes reading and reviewing agent output.
   */
  readonly promptingMs: number;
  /**
   * Total model runtime summed across every concurrent worker — "LLM hours".
   * Fifteen agents busy for an hour is fifteen LLM hours. This is measured
   * from provider-reported turn durations wherever they exist, and can far
   * exceed the length of the day.
   */
  readonly llmMs: number;
  readonly agentActiveMs: number;
  readonly wallClockSpanMs: number;
  readonly outputLeverage: number;
  readonly wallClockAcceleration: number;
  readonly parallelismLeverage: number;
  readonly acceptanceRate: number;
  readonly verificationRate: number;
  readonly reworkRate: number;
  readonly agentAutonomy: number;
  readonly peakConcurrency: number;
  readonly meanConcurrency: number;
  /** Tokens fed to models across the day, cache included. Measured, not estimated. */
  readonly tokensIn: number;
  /** Tokens generated across the day. */
  readonly tokensOut: number;
  /** The portion of `tokensIn` served from cache. */
  readonly tokensCacheRead: number;
  readonly concurrentAgentHours: number;
  readonly taskCount: number;
  readonly statusCounts: Readonly<Record<TaskStatus, number>>;
  readonly categoryHours: Readonly<Record<string, number>>;
  readonly repoHours: Readonly<Record<string, number>>;
  readonly projectCount: number;
  readonly confidence: ConfidenceLevel;
  readonly confidenceScore: number;
}

// ---------------------------------------------------------------------------
// Parser health
// ---------------------------------------------------------------------------

export interface ParserHealth {
  readonly provider: ProviderId;
  readonly parser: string;
  readonly filesSeen: number;
  readonly bytesRead: number;
  readonly linesRead: number;
  readonly eventsEmitted: number;
  readonly recordsIgnored: number;
  readonly recordsMalformed: number;
  readonly recordsDuplicate: number;
  readonly recordsReplay: number;
  readonly unknownTypes: Readonly<Record<string, number>>;
  readonly providerVersions: Readonly<Record<string, number>>;
  readonly errors: readonly string[];
}
