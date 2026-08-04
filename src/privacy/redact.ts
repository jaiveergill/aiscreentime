/**
 * Secret detection and redaction.
 *
 * Applied at ingest time, before text ever reaches the database. Raw secret
 * values are never stored — not even to prove that redaction happened. We store
 * only a category label and a truncated non-reversible fingerprint so the user
 * can see *that* something was redacted without us retaining the value.
 *
 * This is best-effort. It is documented as best-effort everywhere it surfaces.
 */

export type SecretKind =
  | 'api-key'
  | 'aws-key'
  | 'private-key'
  | 'jwt'
  | 'bearer-token'
  | 'password-assignment'
  | 'connection-string'
  | 'email'
  | 'private-url'
  | 'ip-address'
  | 'home-path'
  | 'env-secret';

export interface RedactionHit {
  readonly kind: SecretKind;
  readonly count: number;
}

export interface RedactionResult {
  readonly text: string;
  readonly hits: readonly RedactionHit[];
  readonly redacted: boolean;
}

interface Rule {
  readonly kind: SecretKind;
  readonly re: RegExp;
  readonly replace: string | ((m: string, ...rest: string[]) => string);
  /** Rules above this tier run even in "light" mode (always-on). */
  readonly always: boolean;
}

const RULES: Rule[] = [
  // --- Hard secrets: always redacted -------------------------------------
  {
    kind: 'private-key',
    re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:private-key]',
    always: true,
  },
  {
    kind: 'aws-key',
    re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g,
    replace: '[REDACTED:aws-key]',
    always: true,
  },
  {
    // Anthropic, OpenAI, GitHub, Slack, Google, Stripe, HuggingFace shapes.
    kind: 'api-key',
    re: /\b(?:sk-ant-[A-Za-z0-9_-]{20,}|sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|(?:r|s)k_(?:live|test)_[A-Za-z0-9]{20,}|hf_[A-Za-z0-9]{30,})/g,
    replace: '[REDACTED:api-key]',
    always: true,
  },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: '[REDACTED:jwt]',
    always: true,
  },
  {
    kind: 'bearer-token',
    re: /\b(?:Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: 'Bearer [REDACTED:bearer-token]',
    always: true,
  },
  {
    kind: 'connection-string',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp|rediss):\/\/[^\s'"`]*@[^\s'"`]+/gi,
    replace: '[REDACTED:connection-string]',
    always: true,
  },
  {
    // KEY=value / "password": "value" shapes for secret-looking names.
    kind: 'env-secret',
    re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*["']?([^\s"',;]{6,})["']?/g,
    replace: (_m: string, name: string) => `${name}=[REDACTED:env-secret]`,
    always: true,
  },
  {
    kind: 'password-assignment',
    re: /\b(password|passwd|pwd|secret)\s*[=:]\s*["']([^"']{4,})["']/gi,
    replace: (_m: string, name: string) => `${name}="[REDACTED:password]"`,
    always: true,
  },

  // --- Identity / locality: redacted in strict mode ------------------------
  {
    kind: 'email',
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    replace: '[REDACTED:email]',
    always: false,
  },
  {
    kind: 'private-url',
    re: /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\d{1,3}(?:\.\d{1,3}){3}|[A-Za-z0-9-]+\.(?:internal|local|corp|intranet|test))(?::\d+)?[^\s'"`]*/gi,
    replace: '[REDACTED:private-url]',
    always: false,
  },
  {
    kind: 'ip-address',
    re: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
    replace: '[REDACTED:ip]',
    always: false,
  },
];

/** Matches the filesystem username segment of a home directory path. */
const HOME_PATH_RE = /(\/(?:Users|home)\/)([^/\s'"`:]+)/g;
const WIN_HOME_RE = /([A-Za-z]:\\Users\\)([^\\\s'"`]+)/g;

export type RedactionMode =
  /** Secrets only. Keeps paths, emails and hostnames intact for local use. */
  | 'standard'
  /** Secrets plus identity and locality signals. Used for anything exported. */
  | 'strict';

export interface RedactOptions {
  readonly mode?: RedactionMode;
  /** Replace the home-directory username with `~`. Always on for exports. */
  readonly maskUsername?: boolean;
  /** Extra literal strings the user asked to remove (case-insensitive). */
  readonly customTerms?: readonly string[];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redact(input: string, opts: RedactOptions = {}): RedactionResult {
  const mode = opts.mode ?? 'standard';
  const strict = mode === 'strict';
  const counts = new Map<SecretKind, number>();
  let text = input;

  const bump = (kind: SecretKind, n: number) => {
    if (n > 0) counts.set(kind, (counts.get(kind) ?? 0) + n);
  };

  for (const rule of RULES) {
    if (!rule.always && !strict) continue;
    let n = 0;
    text = text.replace(rule.re, (...args: unknown[]) => {
      n++;
      if (typeof rule.replace === 'function') {
        return (rule.replace as (...a: unknown[]) => string)(...args);
      }
      return rule.replace;
    });
    bump(rule.kind, n);
  }

  if (opts.maskUsername ?? strict) {
    let n = 0;
    text = text.replace(HOME_PATH_RE, (_m, prefix: string) => {
      n++;
      return `${prefix}~`;
    });
    text = text.replace(WIN_HOME_RE, (_m, prefix: string) => {
      n++;
      return `${prefix}~`;
    });
    bump('home-path', n);
  }

  for (const term of opts.customTerms ?? []) {
    if (term.length < 3) continue;
    const re = new RegExp(escapeRe(term), 'gi');
    let n = 0;
    text = text.replace(re, () => {
      n++;
      return '[REDACTED:custom]';
    });
    bump('env-secret', n);
  }

  const hits = [...counts.entries()].map(([kind, count]) => ({ kind, count }));
  return { text, hits, redacted: hits.length > 0 };
}

/**
 * Redact a filesystem path down to something safe to display. Keeps the tail
 * segments (which carry meaning) and drops the machine-specific prefix.
 */
export function redactPath(p: string, keepSegments = 3): string {
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= keepSegments) return parts.join('/');
  return `…/${parts.slice(-keepSegments).join('/')}`;
}

/**
 * Remove every absolute path from the text entirely.
 *
 * Used for anything that leaves the machine. Keeping the basename is not good
 * enough: for a directory path the basename *is* the repository name, and
 * project directory names routinely carry client names and codenames.
 */
export function stripPaths(input: string): string {
  return input
    .replace(/(?:\/[\w.@~-]+){2,}\/?/g, '[path]')
    .replace(/[A-Za-z]:\\(?:[\w.@~ -]+\\?){2,}/g, '[path]');
}

/**
 * Collapse every absolute path in the text to its basename. Used for *local*
 * display, where the user already has access to their own filesystem.
 */
export function collapsePaths(input: string): string {
  return input
    .replace(/(?:\/[\w.@~-]+){2,}/g, (m) => {
      const base = m.split('/').filter(Boolean).pop() ?? '';
      return base ? `…/${base}` : '…';
    })
    .replace(/[A-Za-z]:\\(?:[\w.@~ -]+\\?){2,}/g, (m) => {
      const base = m.split('\\').filter(Boolean).pop() ?? '';
      return base ? `…\\${base}` : '…';
    });
}

/** True if the text contains anything our always-on rules would redact. */
export function containsSecret(input: string): boolean {
  return RULES.some((r) => r.always && new RegExp(r.re.source, r.re.flags).test(input));
}
