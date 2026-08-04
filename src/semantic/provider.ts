import type { TaskCategory } from '../core/types.ts';
import type { Db } from '../store/db.ts';
import type { Settings } from '../core/config.ts';
import { hashFull } from '../core/util.ts';
import { log } from '../core/log.ts';
import { redact, stripPaths } from '../privacy/redact.ts';
import type { SemanticAdjustment } from '../estimate/model.ts';

/**
 * Optional task-understanding layer.
 *
 * ## Contract
 *
 * This layer is **off by default** and the product is fully functional without
 * it. When enabled it may adjust an estimate by at most ±60%, and it can never
 * *be* the estimate: the deterministic model always runs first and the semantic
 * output is applied as one clamped, named, inspectable factor among many.
 *
 * ## What leaves the machine
 *
 * Only the redacted payload built by `buildPrompt`, which contains:
 *   - the task category and status
 *   - integer counts (files, lines, tests, errors)
 *   - a strict-redacted, 600-character summary of the instruction
 *   - basenames of at most 8 changed files
 *
 * Never: source code, diffs, full transcripts, absolute paths, repository
 * names, remotes, branch names, or commit messages. Every request is written to
 * `external_requests` before it is sent and updated after, so the user can
 * audit exactly what happened and when.
 */

export interface SemanticTaskInput {
  readonly taskId: string;
  readonly title: string;
  readonly category: TaskCategory;
  readonly status: string;
  readonly filesChanged: number;
  readonly linesAdded: number;
  readonly linesRemoved: number;
  readonly subsystems: number;
  readonly testsRun: number;
  readonly testsPassed: number;
  readonly errors: number;
  readonly userInstructions: number;
  readonly instructionSummary: string;
  readonly fileBasenames: readonly string[];
}

export interface SemanticProvider {
  readonly id: string;
  readonly model: string;
  /** True when the request never leaves the machine. */
  readonly isLocal: boolean;
  analyze(tasks: readonly SemanticTaskInput[]): Promise<Map<string, SemanticAdjustment>>;
}

const SYSTEM_PROMPT = `You estimate how long software engineering tasks would take a competent engineer working WITHOUT any AI assistance (no Copilot, no ChatGPT, no coding agents), using a conventional workflow: IDE, debugger, docs, search engines, Stack Overflow, tests, linters.

You are given structured metadata about a task that an AI agent already performed. Your job is NOT to produce an hour estimate. Your job is to judge two things a deterministic model cannot:

1. complexityMultiplier: how much harder or easier this task was than a TYPICAL task of its stated category. 1.0 means typical. Use 0.6 for unusually routine work and 1.6 for unusually intricate work. Consider whether apparent complexity came from the agent flailing rather than the task being hard.
2. boilerplateFraction: what fraction (0 to 1) of the produced output is routine scaffolding a conventional engineer would have copied, generated with a CLI, or written mechanically.

Respond with ONLY a JSON array, one object per task, no prose:
[{"taskId":"...","complexityMultiplier":1.0,"boilerplateFraction":0.2,"rationale":"one short sentence"}]`;

export function buildPrompt(tasks: readonly SemanticTaskInput[]): string {
  const rows = tasks.map((t) => ({
    taskId: t.taskId,
    category: t.category,
    status: t.status,
    filesChanged: t.filesChanged,
    linesAdded: t.linesAdded,
    linesRemoved: t.linesRemoved,
    subsystems: t.subsystems,
    testsRun: t.testsRun,
    testsPassed: t.testsPassed,
    errorsEncountered: t.errors,
    instructionRounds: t.userInstructions,
    summary: t.instructionSummary,
    files: t.fileBasenames.slice(0, 8),
  }));
  return JSON.stringify(rows, null, 1);
}

/** Strip everything machine-identifying before a task description is sent out. */
export function sanitizeTask(
  input: SemanticTaskInput,
  customTerms: readonly string[],
): SemanticTaskInput {
  const opts = { mode: 'strict' as const, maskUsername: true, customTerms };
  // Redact first (secrets, emails, usernames), then remove paths outright. A
  // directory path's basename is the repository name, so collapsing rather than
  // stripping would still leak it.
  const clean = (t: string): string => stripPaths(redact(t, opts).text);
  return {
    ...input,
    title: clean(input.title).slice(0, 120),
    instructionSummary: clean(input.instructionSummary).slice(0, 600),
    // Basenames only: directory structure can identify a private project.
    fileBasenames: input.fileBasenames
      .map((p) => redact(p.split('/').pop() ?? p, opts).text)
      .slice(0, 8),
  };
}

interface RawAdjustment {
  taskId?: string;
  complexityMultiplier?: number;
  boilerplateFraction?: number;
  rationale?: string;
}

/** Validate and clamp model output. Never trust it verbatim. */
export function parseAdjustments(text: string, model: string): Map<string, SemanticAdjustment> {
  const out = new Map<string, SemanticAdjustment>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return out;
  let arr: unknown;
  try {
    arr = JSON.parse(text.slice(start, end + 1));
  } catch {
    return out;
  }
  if (!Array.isArray(arr)) return out;
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as RawAdjustment;
    if (typeof r.taskId !== 'string') continue;
    const cm =
      typeof r.complexityMultiplier === 'number' && Number.isFinite(r.complexityMultiplier)
        ? Math.min(1.6, Math.max(0.6, r.complexityMultiplier))
        : 1;
    const bf =
      typeof r.boilerplateFraction === 'number' && Number.isFinite(r.boilerplateFraction)
        ? Math.min(0.85, Math.max(0, r.boilerplateFraction))
        : 0;
    out.set(r.taskId, {
      complexityMultiplier: cm,
      boilerplateFraction: bf,
      rationale: (r.rationale ?? 'No rationale supplied.').slice(0, 240),
      model,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTTP providers
// ---------------------------------------------------------------------------

interface HttpProviderConfig {
  readonly id: string;
  readonly model: string;
  readonly isLocal: boolean;
  readonly endpoint: string;
  readonly apiKeyEnv?: string;
  readonly buildBody: (system: string, user: string, model: string) => unknown;
  readonly extractText: (json: unknown) => string;
  readonly headers: (key: string | undefined) => Record<string, string>;
}

const ANTHROPIC: HttpProviderConfig = {
  id: 'anthropic',
  model: 'claude-sonnet-5',
  isLocal: false,
  endpoint: 'https://api.anthropic.com/v1/messages',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  buildBody: (system, user, model) => ({
    model,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: user }],
  }),
  extractText: (json) => {
    const j = json as { content?: { type?: string; text?: string }[] };
    return (j.content ?? []).map((c) => c.text ?? '').join('');
  },
  headers: (key) => ({
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    ...(key ? { 'x-api-key': key } : {}),
  }),
};

const OPENAI: HttpProviderConfig = {
  id: 'openai',
  model: 'gpt-4o-mini',
  isLocal: false,
  endpoint: 'https://api.openai.com/v1/chat/completions',
  apiKeyEnv: 'OPENAI_API_KEY',
  buildBody: (system, user, model) => ({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0,
  }),
  extractText: (json) => {
    const j = json as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
  },
  headers: (key) => ({
    'content-type': 'application/json',
    ...(key ? { authorization: `Bearer ${key}` } : {}),
  }),
};

class HttpSemanticProvider implements SemanticProvider {
  readonly id: string;
  readonly model: string;
  readonly isLocal: boolean;
  private readonly cfg: HttpProviderConfig;
  private readonly db: Db;
  private readonly customTerms: readonly string[];

  constructor(cfg: HttpProviderConfig, db: Db, model: string, customTerms: readonly string[]) {
    this.cfg = cfg;
    this.db = db;
    this.id = cfg.id;
    this.model = model || cfg.model;
    this.isLocal = cfg.isLocal;
    this.customTerms = customTerms;
  }

  async analyze(tasks: readonly SemanticTaskInput[]): Promise<Map<string, SemanticAdjustment>> {
    if (tasks.length === 0) return new Map();
    const sanitized = tasks.map((t) => sanitizeTask(t, this.customTerms));
    const user = buildPrompt(sanitized);
    const key = hashFull(`${this.id}|${this.model}|${user}`);

    const cached = this.db.handle
      .prepare('SELECT payload FROM semantic_cache WHERE key = ?')
      .get(key) as { payload: string } | undefined;
    if (cached) {
      try {
        const entries = JSON.parse(cached.payload) as [string, SemanticAdjustment][];
        return new Map(entries);
      } catch {
        /* fall through and re-request */
      }
    }

    const apiKey = this.cfg.apiKeyEnv ? process.env[this.cfg.apiKeyEnv] : undefined;
    if (!this.isLocal && !apiKey) {
      log.warn('semantic analysis skipped: no API key', { env: this.cfg.apiKeyEnv });
      return new Map();
    }

    const bytesSent = Buffer.byteLength(user, 'utf8') + Buffer.byteLength(SYSTEM_PROMPT, 'utf8');
    const reqId = this.logRequest('pending', bytesSent, `analyze ${tasks.length} task(s)`);

    try {
      const res = await fetch(this.cfg.endpoint, {
        method: 'POST',
        headers: this.cfg.headers(apiKey),
        body: JSON.stringify(this.cfg.buildBody(SYSTEM_PROMPT, user, this.model)),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        this.updateRequest(reqId, 'failed', `HTTP ${res.status}`);
        log.warn('semantic request failed', { status: res.status });
        return new Map();
      }
      const json = (await res.json()) as unknown;
      const text = this.cfg.extractText(json);
      const parsed = parseAdjustments(text, this.model);
      this.updateRequest(reqId, 'ok', `${parsed.size} adjustment(s) returned`);
      this.db.handle
        .prepare(
          'INSERT OR REPLACE INTO semantic_cache (key, payload, model, created_at) VALUES (?,?,?,?)',
        )
        .run(key, JSON.stringify([...parsed.entries()]), this.model, Date.now());
      return parsed;
    } catch (err) {
      this.updateRequest(reqId, 'failed', String(err).slice(0, 200));
      log.warn('semantic request errored', { err: String(err) });
      return new Map();
    }
  }

  private logRequest(status: string, bytes: number, purpose: string): number {
    const info = this.db.handle
      .prepare(
        `INSERT INTO external_requests (ts, provider, endpoint, purpose, bytes_sent, redacted, status, detail)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(Date.now(), this.id, this.cfg.endpoint, purpose, bytes, 1, status, null);
    return Number(info.lastInsertRowid);
  }

  private updateRequest(id: number, status: string, detail: string): void {
    this.db.handle
      .prepare('UPDATE external_requests SET status = ?, detail = ? WHERE id = ?')
      .run(status, detail, id);
  }
}

/** Build the configured provider, or `undefined` when semantics are disabled. */
export function createSemanticProvider(db: Db, settings: Settings): SemanticProvider | undefined {
  if (!settings.semanticEnabled) return undefined;
  switch (settings.semanticProvider) {
    case 'anthropic':
      return new HttpSemanticProvider(
        ANTHROPIC,
        db,
        settings.semanticModel,
        settings.customRedactTerms,
      );
    case 'openai':
      return new HttpSemanticProvider(
        OPENAI,
        db,
        settings.semanticModel,
        settings.customRedactTerms,
      );
    case 'local':
      return new HttpSemanticProvider(
        {
          ...OPENAI,
          id: 'local',
          isLocal: true,
          endpoint: `${settings.semanticLocalBaseUrl.replace(/\/$/, '')}/chat/completions`,
          ...(OPENAI.apiKeyEnv ? {} : {}),
        },
        db,
        settings.semanticModel,
        settings.customRedactTerms,
      );
    default:
      return undefined;
  }
}

export function listExternalRequests(db: Db, limit = 100): Record<string, unknown>[] {
  return db.handle
    .prepare('SELECT * FROM external_requests ORDER BY ts DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
}

export { SYSTEM_PROMPT };
