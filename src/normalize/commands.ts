/**
 * Shell command classification.
 *
 * Both providers record executed commands. Classifying them is how we detect
 * verification signals (tests, builds, type checks, linters) without trusting
 * any agent's self-report about whether it "verified" anything.
 */

export type CommandClass =
  | 'test'
  | 'build'
  | 'lint'
  | 'typecheck'
  | 'git-read'
  | 'git-write'
  | 'package-manager'
  | 'deploy'
  | 'run'
  | 'search'
  | 'file-read'
  | 'file-write'
  | 'navigation'
  | 'other';

export interface CommandInfo {
  readonly cls: CommandClass;
  /** The specific tool recognised, e.g. `pytest`, `cargo`, `eslint`. */
  readonly tool?: string;
  /** True when this command, if it exits 0, is meaningful verification. */
  readonly isVerification: boolean;
}

interface Pattern {
  readonly re: RegExp;
  readonly cls: CommandClass;
  readonly tool: string;
  readonly verification: boolean;
}

// Ordered: earlier patterns win. Type checks and lint must be tested before the
// generic package-manager pattern, since they are usually run through npm/yarn.
const PATTERNS: Pattern[] = [
  // --- type checking -------------------------------------------------------
  { re: /\btsc\b(?!.*--init)/, cls: 'typecheck', tool: 'tsc', verification: true },
  { re: /\bmypy\b/, cls: 'typecheck', tool: 'mypy', verification: true },
  { re: /\bpyright\b/, cls: 'typecheck', tool: 'pyright', verification: true },
  { re: /\bflow\s+check\b/, cls: 'typecheck', tool: 'flow', verification: true },
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|tsc)\b/,
    cls: 'typecheck',
    tool: 'npm-script',
    verification: true,
  },

  // --- linting -------------------------------------------------------------
  { re: /\beslint\b/, cls: 'lint', tool: 'eslint', verification: true },
  { re: /\bruff\b/, cls: 'lint', tool: 'ruff', verification: true },
  { re: /\bflake8\b/, cls: 'lint', tool: 'flake8', verification: true },
  { re: /\bpylint\b/, cls: 'lint', tool: 'pylint', verification: true },
  { re: /\bclippy\b|\bcargo\s+clippy\b/, cls: 'lint', tool: 'clippy', verification: true },
  { re: /\bgolangci-lint\b/, cls: 'lint', tool: 'golangci-lint', verification: true },
  { re: /\bshellcheck\b/, cls: 'lint', tool: 'shellcheck', verification: true },
  { re: /\bswiftlint\b/, cls: 'lint', tool: 'swiftlint', verification: true },
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/,
    cls: 'lint',
    tool: 'npm-script',
    verification: true,
  },

  // --- tests ---------------------------------------------------------------
  { re: /\bpytest\b/, cls: 'test', tool: 'pytest', verification: true },
  { re: /\bjest\b/, cls: 'test', tool: 'jest', verification: true },
  { re: /\bvitest\b/, cls: 'test', tool: 'vitest', verification: true },
  { re: /\bmocha\b/, cls: 'test', tool: 'mocha', verification: true },
  { re: /\bplaywright\s+test\b/, cls: 'test', tool: 'playwright', verification: true },
  { re: /\bcypress\s+run\b/, cls: 'test', tool: 'cypress', verification: true },
  { re: /\bcargo\s+test\b/, cls: 'test', tool: 'cargo-test', verification: true },
  { re: /\bgo\s+test\b/, cls: 'test', tool: 'go-test', verification: true },
  { re: /\bnode\s+--test\b/, cls: 'test', tool: 'node-test', verification: true },
  {
    re: /\bpython[0-9.]*\s+-m\s+(?:unittest|pytest)\b/,
    cls: 'test',
    tool: 'python',
    verification: true,
  },
  { re: /\bxcodebuild\b.*\btest\b/, cls: 'test', tool: 'xcodebuild', verification: true },
  { re: /\bswift\s+test\b/, cls: 'test', tool: 'swift-test', verification: true },
  { re: /\bgradlew?\b.*\btest\b/, cls: 'test', tool: 'gradle', verification: true },
  { re: /\bmvn\b.*\btest\b/, cls: 'test', tool: 'maven', verification: true },
  { re: /\brspec\b/, cls: 'test', tool: 'rspec', verification: true },
  { re: /\bphpunit\b/, cls: 'test', tool: 'phpunit', verification: true },
  { re: /\bdotnet\s+test\b/, cls: 'test', tool: 'dotnet-test', verification: true },
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?tests?\b/,
    cls: 'test',
    tool: 'npm-script',
    verification: true,
  },
  { re: /\bmake\s+(?:test|check)\b/, cls: 'test', tool: 'make', verification: true },

  // --- builds --------------------------------------------------------------
  { re: /\bcargo\s+(?:build|check)\b/, cls: 'build', tool: 'cargo', verification: true },
  { re: /\bgo\s+build\b/, cls: 'build', tool: 'go', verification: true },
  { re: /\bxcodebuild\b/, cls: 'build', tool: 'xcodebuild', verification: true },
  { re: /\bswift\s+build\b/, cls: 'build', tool: 'swift', verification: true },
  { re: /\bgradlew?\b/, cls: 'build', tool: 'gradle', verification: true },
  { re: /\bmvn\b/, cls: 'build', tool: 'maven', verification: true },
  { re: /\bdotnet\s+build\b/, cls: 'build', tool: 'dotnet', verification: true },
  {
    re: /\bwebpack\b|\bvite\s+build\b|\besbuild\b|\brollup\b/,
    cls: 'build',
    tool: 'bundler',
    verification: true,
  },
  { re: /\bdocker\s+build\b/, cls: 'build', tool: 'docker', verification: true },
  { re: /\bcmake\b|\bmake\b(?!\s+(?:test|check))/, cls: 'build', tool: 'make', verification: true },
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/,
    cls: 'build',
    tool: 'npm-script',
    verification: true,
  },

  // --- deployment ----------------------------------------------------------
  {
    re: /\b(?:fly\s+deploy|vercel\s+(?:deploy|--prod)|netlify\s+deploy|gcloud\s+(?:app\s+deploy|run\s+deploy)|kubectl\s+apply|terraform\s+apply|eb\s+deploy|heroku\s+.*(?:push|release))\b/,
    cls: 'deploy',
    tool: 'deploy',
    verification: true,
  },

  // --- git -----------------------------------------------------------------
  {
    re: /\bgit\s+(?:commit|push|merge|rebase|revert|reset|cherry-pick|tag|stash\s+(?:pop|apply)|checkout\s+-b|switch\s+-c|worktree\s+add)\b/,
    cls: 'git-write',
    tool: 'git',
    verification: false,
  },
  {
    re: /\bgit\s+(?:status|diff|log|show|blame|branch|remote|rev-parse|ls-files|reflog|describe|stash\s+list)\b/,
    cls: 'git-read',
    tool: 'git',
    verification: false,
  },

  // --- package managers ----------------------------------------------------
  {
    re: /\b(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|remove|ci|update)\b|\bpip3?\s+install\b|\bpoetry\s+(?:add|install)\b|\buv\s+(?:add|pip|sync)\b|\bcargo\s+(?:add|update)\b|\bgo\s+(?:get|mod)\b|\bbrew\s+install\b|\bgem\s+install\b/,
    cls: 'package-manager',
    tool: 'package-manager',
    verification: false,
  },

  // --- search / read / navigate -------------------------------------------
  { re: /^\s*(?:rg|grep|ag|ack|fd|find)\b/, cls: 'search', tool: 'search', verification: false },
  {
    re: /^\s*(?:cat|head|tail|less|more|bat|wc|file|stat|jq)\b/,
    cls: 'file-read',
    tool: 'read',
    verification: false,
  },
  {
    re: /^\s*(?:mkdir|touch|cp|mv|rm|chmod|chown|ln|sed\s+-i|tee)\b/,
    cls: 'file-write',
    tool: 'write',
    verification: false,
  },
  {
    re: /^\s*(?:cd|ls|pwd|tree|echo|which|env|export)\b/,
    cls: 'navigation',
    tool: 'shell',
    verification: false,
  },
];

const cache = new Map<string, CommandInfo>();
const OTHER: CommandInfo = { cls: 'other', isVerification: false };

/** Classify a shell command string. Memoized: transcripts repeat commands a lot. */
export function classifyCommand(raw: string | undefined): CommandInfo {
  if (!raw) return OTHER;
  const cmd = raw.length > 400 ? raw.slice(0, 400) : raw;
  const hit = cache.get(cmd);
  if (hit) return hit;

  let result: CommandInfo = OTHER;
  for (const p of PATTERNS) {
    if (p.re.test(cmd)) {
      result = { cls: p.cls, tool: p.tool, isVerification: p.verification };
      break;
    }
  }
  if (cache.size < 5000) cache.set(cmd, result);
  return result;
}

/**
 * Best-effort pass/fail verdict for a command execution.
 *
 * Exit code is authoritative when present. Otherwise we fall back to output
 * scanning, which is deliberately conservative: ambiguous output yields
 * `unknown`, never `pass`.
 */
export function classifyOutcome(
  exitCode: number | undefined,
  stdout: string | undefined,
  stderr: string | undefined,
): 'pass' | 'fail' | 'unknown' {
  if (exitCode === 0) return 'pass';
  if (typeof exitCode === 'number' && exitCode !== 0) return 'fail';

  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  if (text.trim().length === 0) return 'unknown';
  // No trailing \b: several alternatives end in punctuation, where a word
  // boundary can never match.
  const failRe =
    /\d+\s+fail(?:ed|ing|ures?)|\bFAILED\b|\bFAIL\b|\berror[:s]?\s|Traceback \(most recent call last\)|\bpanic:|Exception in thread|BUILD FAILED|compilation failed|✗|✖/;
  const passRe =
    /\b(?:\d+\s+pass(?:ed|ing)|all tests passed|BUILD SUCCEEDED|Build succeeded|✓ \d+|OK \(\d+ tests?\)|Compiled successfully|0 errors?)\b/i;
  if (failRe.test(text)) return 'fail';
  if (passRe.test(text)) return 'pass';
  return 'unknown';
}

/** True when a command string looks like an interrupted / aborted run. */
export function looksInterrupted(text: string | undefined): boolean {
  if (!text) return false;
  return /\b(?:KeyboardInterrupt|SIGINT|Interrupted by user|command was aborted)\b/i.test(text);
}
