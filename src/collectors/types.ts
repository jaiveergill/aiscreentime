import type { NormalizedEvent, ParserHealth, ProviderId } from '../core/types.ts';

/** Where a provider keeps its data, and whether we found it. */
export interface ProviderDetection {
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly installed: boolean;
  /** Absolute directories that would be read. Shown verbatim in onboarding. */
  readonly dataDirs: readonly string[];
  /** Directories that exist right now. */
  readonly foundDirs: readonly string[];
  readonly sessionFileCount: number;
  readonly totalBytes: number;
  readonly earliest?: number;
  readonly latest?: number;
  /** Versions observed in the data, most recent first. */
  readonly versionsSeen: readonly string[];
  readonly notes: readonly string[];
}

/** One transcript file on disk. */
export interface SourceFile {
  readonly provider: ProviderId;
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** Provider hint about which session this file holds, when derivable. */
  readonly sessionHint?: string;
  /** Provider hint about the project/cwd, when derivable from the path. */
  readonly projectHint?: string;
}

export interface ParseContext {
  /** Resume parsing from this byte offset. 0 means the whole file. */
  readonly fromByte: number;
  /** Line index corresponding to `fromByte`. */
  readonly fromLine: number;
  /** Ids of events already ingested, for cheap in-run dedupe. */
  readonly seen: Set<string>;
  /** Redaction is applied by the parser before text is emitted. */
  readonly redactMode: 'standard' | 'strict';
  readonly customRedactTerms: readonly string[];
  /** Abort signal for cancellation during long ingests. */
  readonly signal?: AbortSignal;
}

export interface ParseResult {
  readonly events: NormalizedEvent[];
  /** Byte offset immediately after the last *complete* line consumed. */
  readonly bytesConsumed: number;
  readonly linesConsumed: number;
  readonly health: ParserHealth;
  /** Session-level metadata discovered while parsing. */
  readonly sessions: SessionSeed[];
}

/** Session facts a parser can assert directly from the transcript. */
export interface SessionSeed {
  readonly sessionId: string;
  readonly provider: ProviderId;
  readonly sourceFile: string;
  readonly cwd?: string;
  readonly branch?: string;
  readonly title?: string;
  readonly model?: string;
  readonly providerVersion?: string;
  readonly parentSessionId?: string;
  readonly kind: 'primary' | 'subagent' | 'fork' | 'resume';
  readonly repositoryUrl?: string;
  readonly commitHash?: string;
}

export interface Collector {
  readonly id: ProviderId;
  readonly displayName: string;
  /** Directories this collector reads. Never anything outside these. */
  dataDirs(): string[];
  detect(): Promise<ProviderDetection>;
  discover(): Promise<SourceFile[]>;
  /** Parse a file incrementally. Must tolerate every malformed input. */
  parse(file: SourceFile, ctx: ParseContext): Promise<ParseResult>;
}

export function emptyHealth(provider: ProviderId, parser: string): ParserHealth {
  return {
    provider,
    parser,
    filesSeen: 0,
    bytesRead: 0,
    linesRead: 0,
    eventsEmitted: 0,
    recordsIgnored: 0,
    recordsMalformed: 0,
    recordsDuplicate: 0,
    recordsReplay: 0,
    unknownTypes: {},
    providerVersions: {},
    errors: [],
  };
}

/** Mutable accumulator used inside parsers; frozen into `ParserHealth` at the end. */
export class HealthAccumulator {
  filesSeen = 0;
  bytesRead = 0;
  linesRead = 0;
  eventsEmitted = 0;
  recordsIgnored = 0;
  recordsMalformed = 0;
  recordsDuplicate = 0;
  recordsReplay = 0;
  readonly unknownTypes = new Map<string, number>();
  readonly providerVersions = new Map<string, number>();
  readonly errors: string[] = [];
  readonly provider: ProviderId;
  readonly parser: string;

  constructor(provider: ProviderId, parser: string) {
    this.provider = provider;
    this.parser = parser;
  }

  unknown(type: string): void {
    this.unknownTypes.set(type, (this.unknownTypes.get(type) ?? 0) + 1);
  }

  version(v: string | undefined): void {
    if (!v) return;
    this.providerVersions.set(v, (this.providerVersions.get(v) ?? 0) + 1);
  }

  error(msg: string): void {
    if (this.errors.length < 50) this.errors.push(msg);
  }

  freeze(): ParserHealth {
    return {
      provider: this.provider,
      parser: this.parser,
      filesSeen: this.filesSeen,
      bytesRead: this.bytesRead,
      linesRead: this.linesRead,
      eventsEmitted: this.eventsEmitted,
      recordsIgnored: this.recordsIgnored,
      recordsMalformed: this.recordsMalformed,
      recordsDuplicate: this.recordsDuplicate,
      recordsReplay: this.recordsReplay,
      unknownTypes: Object.fromEntries(this.unknownTypes),
      providerVersions: Object.fromEntries(this.providerVersions),
      errors: this.errors,
    };
  }
}

export function mergeHealth(a: ParserHealth, b: ParserHealth): ParserHealth {
  const unknownTypes = { ...a.unknownTypes };
  for (const [k, v] of Object.entries(b.unknownTypes)) unknownTypes[k] = (unknownTypes[k] ?? 0) + v;
  const providerVersions = { ...a.providerVersions };
  for (const [k, v] of Object.entries(b.providerVersions)) {
    providerVersions[k] = (providerVersions[k] ?? 0) + v;
  }
  return {
    provider: a.provider,
    parser: a.parser,
    filesSeen: a.filesSeen + b.filesSeen,
    bytesRead: a.bytesRead + b.bytesRead,
    linesRead: a.linesRead + b.linesRead,
    eventsEmitted: a.eventsEmitted + b.eventsEmitted,
    recordsIgnored: a.recordsIgnored + b.recordsIgnored,
    recordsMalformed: a.recordsMalformed + b.recordsMalformed,
    recordsDuplicate: a.recordsDuplicate + b.recordsDuplicate,
    recordsReplay: a.recordsReplay + b.recordsReplay,
    unknownTypes,
    providerVersions,
    errors: [...a.errors, ...b.errors].slice(0, 50),
  };
}
