import type { Db } from '../store/db.ts';
import type { RedactionMode } from '../privacy/redact.ts';

export interface Settings {
  /** Onboarding has been completed at least once. */
  onboarded: boolean;
  /** Providers the user has enabled. */
  providers: Record<string, boolean>;
  /** How far back to ingest, in days. 0 means "everything". */
  historyDays: number;
  /** Ingestion is paused entirely. */
  paused: boolean;
  /** Repository roots explicitly excluded by the user. */
  excludedRepos: string[];
  /** Session ids explicitly excluded. */
  excludedSessions: string[];
  /** Task categories excluded from the headline. */
  excludedCategories: string[];
  /** Redaction level applied at ingest. */
  redactMode: RedactionMode;
  /** Extra literal strings to scrub. */
  customRedactTerms: string[];
  /** Semantic (LLM) task understanding. Off unless explicitly enabled. */
  semanticEnabled: boolean;
  semanticProvider: 'none' | 'anthropic' | 'openai' | 'local';
  semanticModel: string;
  /** Base URL for a local OpenAI-compatible server (Ollama, LM Studio, …). */
  semanticLocalBaseUrl: string;
  /** Max tasks per run sent for semantic analysis. Bounds cost and exposure. */
  semanticMaxTasksPerRun: number;
  /** Retention for raw events, in days. 0 means keep forever. */
  retentionDays: number;
  /** Display timezone; empty means system local. */
  timezone: string;
  /**
   * Seconds between automatic rescans while the dashboard is open.
   * 0 disables it; the minimum enforced interval is 15s.
   */
  autoRefreshSeconds: number;
}

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  providers: { 'claude-code': true, codex: true },
  historyDays: 30,
  paused: false,
  excludedRepos: [],
  excludedSessions: [],
  excludedCategories: [],
  redactMode: 'standard',
  customRedactTerms: [],
  semanticEnabled: false,
  semanticProvider: 'none',
  semanticModel: 'claude-sonnet-5',
  semanticLocalBaseUrl: 'http://127.0.0.1:11434/v1',
  semanticMaxTasksPerRun: 40,
  retentionDays: 0,
  timezone: '',
  autoRefreshSeconds: 60,
};

/**
 * Read settings, re-validating what was stored.
 *
 * Validating only on write is not enough: a row written by an older build, a
 * hand-edited database, or any future path that does not go through
 * `saveSettings` would otherwise be trusted verbatim. Sanitising on read means
 * every consumer of `Settings` gets a value that satisfies the declared type
 * and range, whatever is actually on disk.
 */
export function loadSettings(db: Db): Settings {
  const stored = db.getConfig<Partial<Settings>>('settings', {});
  return { ...DEFAULT_SETTINGS, ...sanitizeSettingsPatch(stored) };
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * True when the URL is a well-formed http(s) URL pointing at this machine.
 *
 * The `local` semantic provider asserts `isLocal: true`, and the settings UI
 * tells the user nothing leaves the machine. That promise is only true if the
 * endpoint is actually loopback, so it is enforced here rather than trusted.
 */
export function isLoopbackUrl(value: string): boolean {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return LOOPBACK_HOSTS.has(u.hostname);
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const strArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every(isStr) ? (v as string[]) : undefined;
const intIn = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(hi, Math.max(lo, Math.trunc(v)))
    : undefined;

/**
 * Drop unknown keys and coerce known ones to their declared type and range.
 *
 * `POST /api/settings` and `POST /api/onboard/complete` both forward a raw JSON
 * body here, so this is the trust boundary for anything a browser can reach.
 * Invalid values are dropped rather than rejected: a malformed patch leaves the
 * stored setting at its previous value instead of failing the whole request.
 */
export function sanitizeSettingsPatch(raw: unknown): Partial<Settings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const i = raw as Record<string, unknown>;
  const out: Partial<Settings> = {};

  if (typeof i['onboarded'] === 'boolean') out.onboarded = i['onboarded'];
  if (typeof i['paused'] === 'boolean') out.paused = i['paused'];
  if (typeof i['semanticEnabled'] === 'boolean') out.semanticEnabled = i['semanticEnabled'];

  const providers = i['providers'];
  if (providers && typeof providers === 'object' && !Array.isArray(providers)) {
    const clean: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(providers)) if (typeof v === 'boolean') clean[k] = v;
    out.providers = clean;
  }

  const historyDays = intIn(i['historyDays'], 0, 36_500);
  if (historyDays !== undefined) out.historyDays = historyDays;
  const retentionDays = intIn(i['retentionDays'], 0, 36_500);
  if (retentionDays !== undefined) out.retentionDays = retentionDays;
  const maxTasks = intIn(i['semanticMaxTasksPerRun'], 1, 1000);
  if (maxTasks !== undefined) out.semanticMaxTasksPerRun = maxTasks;
  const refresh = intIn(i['autoRefreshSeconds'], 0, 86_400);
  if (refresh !== undefined) out.autoRefreshSeconds = refresh;

  const excludedRepos = strArray(i['excludedRepos']);
  if (excludedRepos) out.excludedRepos = excludedRepos;
  const excludedSessions = strArray(i['excludedSessions']);
  if (excludedSessions) out.excludedSessions = excludedSessions;
  const excludedCategories = strArray(i['excludedCategories']);
  if (excludedCategories) out.excludedCategories = excludedCategories;
  const customRedactTerms = strArray(i['customRedactTerms']);
  if (customRedactTerms) out.customRedactTerms = customRedactTerms;

  if (i['redactMode'] === 'standard' || i['redactMode'] === 'strict')
    out.redactMode = i['redactMode'];

  const sp = i['semanticProvider'];
  if (sp === 'none' || sp === 'anthropic' || sp === 'openai' || sp === 'local') {
    out.semanticProvider = sp;
  }
  if (isStr(i['semanticModel'])) out.semanticModel = i['semanticModel'].slice(0, 200);
  if (isStr(i['timezone'])) out.timezone = i['timezone'].slice(0, 100);

  // Rejected outright rather than clamped: a non-loopback URL would silently
  // break the local-only guarantee the UI makes for this provider.
  if (isStr(i['semanticLocalBaseUrl']) && isLoopbackUrl(i['semanticLocalBaseUrl'])) {
    out.semanticLocalBaseUrl = i['semanticLocalBaseUrl'];
  }

  return out;
}

export function saveSettings(db: Db, patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(db), ...sanitizeSettingsPatch(patch) };
  db.setConfig('settings', next);
  return next;
}
