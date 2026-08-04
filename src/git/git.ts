import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { hashId } from '../core/util.ts';
import { log } from '../core/log.ts';

/**
 * Read-only Git access.
 *
 * Every command here is a query. Nothing in this file may mutate a repository:
 * no `add`, `commit`, `checkout`, `stash`, `gc`, or config writes. The command
 * allowlist below is enforced at the single choke point `git()`.
 */
const ALLOWED_SUBCOMMANDS = new Set([
  'rev-parse',
  'log',
  'status',
  'diff',
  'show',
  'ls-files',
  'worktree',
  'config',
  'cat-file',
  'name-rev',
]);

export interface GitCommit {
  readonly sha: string;
  /** Commit timestamp, epoch ms. */
  readonly ts: number;
  readonly authorTs: number;
  /** Hash of the subject line. We never store commit messages verbatim. */
  readonly subjectHash: string;
  /** First 80 chars of the subject, redaction-eligible, for the task view. */
  readonly subjectPreview: string;
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
  readonly isRevert: boolean;
  readonly revertsSha?: string;
  readonly paths: readonly string[];
}

export interface GitStatus {
  readonly clean: boolean;
  readonly modified: readonly string[];
  readonly untracked: readonly string[];
  readonly staged: readonly string[];
}

function git(root: string, args: string[], timeoutMs = 10_000): string | null {
  const sub = args[0];
  if (!sub || !ALLOWED_SUBCOMMANDS.has(sub)) {
    log.error('blocked non-readonly git subcommand', { sub });
    return null;
  }
  // `git config` is allowlisted only for reads.
  if (sub === 'config' && !args.includes('--get')) return null;
  // `git worktree` is allowlisted only for `list`.
  if (sub === 'worktree' && args[1] !== 'list') return null;

  try {
    const res = spawnSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
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

export function repoRoot(dir: string): string | null {
  const out = git(dir, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

/** Hash of the remote URL. The URL itself is never stored or exported. */
export function remoteUrlHash(root: string): string | undefined {
  const out = git(root, ['config', '--get', 'remote.origin.url']);
  if (!out) return undefined;
  return hashId('remote', out.trim());
}

export function currentBranch(root: string): string | undefined {
  const out = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return out ? out.trim() : undefined;
}

export function listWorktrees(root: string): string[] {
  const out = git(root, ['worktree', 'list', '--porcelain']);
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^worktree (.+)$/.exec(line);
    if (m?.[1]) paths.push(m[1]);
  }
  return paths;
}

export function status(root: string): GitStatus {
  const out = git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  if (out === null) return { clean: true, modified: [], untracked: [], staged: [] };
  const modified: string[] = [];
  const untracked: string[] = [];
  const staged: string[] = [];
  for (const line of out.split('\n')) {
    if (line.length < 4) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const file = line.slice(3).trim();
    if (x === '?' && y === '?') untracked.push(file);
    else {
      if (x !== ' ') staged.push(file);
      if (y !== ' ') modified.push(file);
    }
  }
  return {
    clean: modified.length === 0 && untracked.length === 0 && staged.length === 0,
    modified,
    untracked,
    staged,
  };
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
      subjectPreview: subj.slice(0, 80),
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

/** Which of these paths still exist in the working tree right now? */
export function pathsExist(
  root: string,
  paths: readonly string[],
): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const p of paths) {
    const abs = path.isAbsolute(p) ? p : path.join(root, p);
    try {
      if (fs.existsSync(abs)) present.push(p);
      else missing.push(p);
    } catch {
      missing.push(p);
    }
  }
  return { present, missing };
}

/**
 * Was the content at `filePath` later reverted?
 *
 * Answers by checking whether any commit touching the path is a revert, or
 * whether the file was subsequently deleted. Deliberately conservative: it
 * reports "possibly reverted", never a certainty.
 */
export function laterRevertsTouching(
  root: string,
  paths: readonly string[],
  afterMs: number,
): GitCommit[] {
  if (paths.length === 0) return [];
  const commits = commitsInRange(root, afterMs, Date.now());
  const set = new Set(paths.map((p) => (path.isAbsolute(p) ? path.relative(root, p) : p)));
  return commits.filter((c) => c.isRevert && c.paths.some((p) => set.has(p)));
}
