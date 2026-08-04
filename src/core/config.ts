import type { Db } from '../store/db.ts';
import type { EstimateMode } from './types.ts';
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
  /** Default estimate mode for the dashboard. */
  mode: EstimateMode;
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
  /** Extra directories the user authorised us to watch. */
  extraWatchDirs: string[];
  /** Display timezone; empty means system local. */
  timezone: string;
  /** Share cards use aliases instead of real project names. */
  shareUseAliases: boolean;
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
  mode: 'conservative',
  semanticEnabled: false,
  semanticProvider: 'none',
  semanticModel: 'claude-sonnet-5',
  semanticLocalBaseUrl: 'http://127.0.0.1:11434/v1',
  semanticMaxTasksPerRun: 40,
  retentionDays: 0,
  extraWatchDirs: [],
  timezone: '',
  shareUseAliases: true,
  autoRefreshSeconds: 60,
};

export function loadSettings(db: Db): Settings {
  const stored = db.getConfig<Partial<Settings>>('settings', {});
  return { ...DEFAULT_SETTINGS, ...stored };
}

export function saveSettings(db: Db, patch: Partial<Settings>): Settings {
  const next = { ...loadSettings(db), ...patch };
  db.setConfig('settings', next);
  return next;
}
