import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

import { hashId } from '../core/util.ts';
import { log } from '../core/log.ts';

/**
 * Read-only Git access.
 *
 * Every command here is a query. Nothing in this file may mutate a repository:
 * no `add`, `commit`, `checkout`, `stash`, `gc`, or config writes. The command
 * allowlist below is enforced at the single choke point `git()`.
 */
const ALLOWED_SUBCOMMANDS = new Set(['rev-parse', 'log']);

export interface GitCommit {
  readonly sha: string;
  /** Commit timestamp, epoch ms. */
  readonly ts: number;
  readonly authorTs: number;
  /** Hash of the subject line. We never store commit messages verbatim. */
  readonly subjectHash: string;
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly isRevert: boolean;
  readonly revertsSha?: string;
  readonly paths: readonly string[];
}

/**
 * Config overrides applied to every invocation.
 *
 * We run against repositories the user merely pointed an agent at, so the
 * repo-local `.git/config` and `.gitattributes` are attacker-controlled input.
 * Git has several config keys that turn a read-only query into command
 * execution — `core.fsmonitor`, `diff.external`, and `*.textconv` filters are
 * the usual ones — so they are neutralised here rather than trusted.
 */
const SAFE_CONFIG = [
  '-c',
  'core.fsmonitor=',
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'diff.external=',
  '-c',
  'protocol.ext.allow=never',
];

function git(root: string, args: string[], timeoutMs = 10_000): string | null {
  const sub = args[0];
  if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) {
    log.error('blocked non-readonly git subcommand', { sub });
    return null;
  }

  try {
    const res = spawnSync('git', [...SAFE_CONFIG, '-C', root, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        // Ignore machine- and user-level git config; only the flags above apply.
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_ATTR_NOSYSTEM: '1',
      },
    });
    if (res.error || res.status !== 0) return null;
    return res.stdout;
  } catch (err) {
    log.debug('git command failed', { root, args: args.join(' '), err: String(err) });
    return null;
  }
}

export function isGitRepo(root: string): boolean {
  if (!fs.existsSync(root)) return false;
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

/**
 * Commits in a time window, with per-commit stats.
 *
 * Uses `--all` so commits on other branches and worktrees are visible, and
 * `--no-merges` because a merge commit is not itself authored work.
 */
export function commitsInRange(root: string, sinceMs: number, untilMs: number): GitCommit[] {
  const since = Math.floor(sinceMs / 1000);
  const until = Math.ceil(untilMs / 1000);
  const SEP = '';
  const REC = '';
  const out = git(root, [
    'log',
    '--all',
    '--no-merges',
    `--since=${since}`,
    `--until=${until}`,
    `--pretty=format:${REC}%H${SEP}%ct${SEP}%at${SEP}%s`,
    '--numstat',
    '--max-count=2000',
  ]);
  if (!out) return [];

  const commits: GitCommit[] = [];
  for (const chunk of out.split(REC)) {
    if (!chunk.trim()) continue;
    const nl = chunk.indexOf('\n');
    const headerLine = nl >= 0 ? chunk.slice(0, nl) : chunk;
    const body = nl >= 0 ? chunk.slice(nl + 1) : '';
    const [sha, ct, at, subject] = headerLine.split(SEP);
    if (!sha) continue;
    let insertions = 0;
    let deletions = 0;
    const paths: string[] = [];
    for (const line of body.split('\n')) {
      const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
      if (!m) continue;
      if (m[1] !== '-') insertions += Number(m[1]);
      if (m[2] !== '-') deletions += Number(m[2]);
      if (m[3]) paths.push(m[3]);
    }
    const subj = subject ?? '';
    const revertMatch = /^Revert "(.+)"$/.exec(subj);
    const revertShaMatch = /This reverts commit ([0-9a-f]{7,40})/.exec(body);
    commits.push({
      sha,
      ts: Number(ct ?? 0) * 1000,
      authorTs: Number(at ?? ct ?? 0) * 1000,
      subjectHash: hashId('subject', subj),
      files: paths.length,
      insertions,
      deletions,
      isRevert: Boolean(revertMatch) || Boolean(revertShaMatch),
      ...(revertShaMatch?.[1] ? { revertsSha: revertShaMatch[1] } : {}),
      paths,
    });
  }
  return commits;
}
