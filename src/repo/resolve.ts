import fs from 'node:fs';
import path from 'node:path';

import type { RepoRecord } from '../core/types.ts';
import { hashId } from '../core/util.ts';

/**
 * Repository resolution.
 *
 * A session's `cwd` is not necessarily a repository root, and may be a linked
 * worktree, a nested repository inside a monorepo, or not a repository at all.
 * We walk upward looking for `.git`, then resolve worktrees to their main
 * checkout so that work done in `feature-x` worktree is attributed to the same
 * project as work done in the main checkout.
 *
 * Non-git directories are still tracked as projects — plenty of real work
 * happens in directories without version control — but they are marked
 * `isGit: false` and receive weaker verification evidence.
 */

export interface ResolveOptions {
  /** Directories the user has authorised. Anything outside is not inspected. */
  readonly allowedRoots?: readonly string[];
  readonly maxDepth?: number;
}

const cache = new Map<string, RepoRecord | null>();

export function clearRepoCache(): void {
  cache.clear();
}

function isAllowed(p: string, allowed: readonly string[] | undefined): boolean {
  if (!allowed || allowed.length === 0) return true;
  const norm = path.resolve(p);
  return allowed.some((root) => {
    const r = path.resolve(root);
    return norm === r || norm.startsWith(`${r}${path.sep}`);
  });
}

/** Find the repository (or plain project directory) containing `cwd`. */
export function resolveRepo(cwd: string | undefined, opts: ResolveOptions = {}): RepoRecord | null {
  if (!cwd) return null;
  const cacheKey = `${cwd}|${(opts.allowedRoots ?? []).join(',')}`;
  const hit = cache.get(cacheKey);
  if (hit !== undefined) return hit;

  const result = resolveUncached(cwd, opts);
  cache.set(cacheKey, result);
  return result;
}

function resolveUncached(cwd: string, opts: ResolveOptions): RepoRecord | null {
  let dir: string;
  try {
    dir = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
  } catch {
    dir = path.resolve(cwd);
  }

  if (!isAllowed(dir, opts.allowedRoots)) return null;

  const maxDepth = opts.maxDepth ?? 12;
  let current = dir;
  for (let i = 0; i < maxDepth; i++) {
    const gitPath = path.join(current, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.statSync(gitPath);
    } catch {
      st = undefined;
    }
    if (st) {
      if (st.isDirectory()) {
        return makeRepo(current, true);
      }
      // A `.git` *file* means this is a linked worktree; it points at the
      // main repository's `.git/worktrees/<name>` directory.
      const mainRoot = readWorktreeMain(gitPath);
      if (mainRoot) {
        const rec = makeRepo(mainRoot, true);
        return { ...rec, worktreeOf: mainRoot };
      }
      return makeRepo(current, true);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    if (!isAllowed(parent, opts.allowedRoots)) break;
    current = parent;
  }

  // Not a git repository. Treat the session cwd itself as the project.
  return makeRepo(dir, false);
}

function readWorktreeMain(gitFile: string): string | undefined {
  try {
    const content = fs.readFileSync(gitFile, 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(content);
    if (!m?.[1]) return undefined;
    const gitdir = m[1].trim();
    // .../<main>/.git/worktrees/<name>  →  <main>
    const idx = gitdir.lastIndexOf(`${path.sep}.git${path.sep}worktrees${path.sep}`);
    if (idx > 0) return gitdir.slice(0, idx);
    const commondir = path.join(gitdir, 'commondir');
    if (fs.existsSync(commondir)) {
      const rel = fs.readFileSync(commondir, 'utf8').trim();
      const resolved = path.resolve(gitdir, rel);
      return path.dirname(resolved);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function makeRepo(root: string, isGit: boolean): RepoRecord {
  return {
    repoId: repoIdFor(root),
    root,
    name: path.basename(root) || root,
    isGit,
    included: true,
  };
}

export function repoIdFor(root: string): string {
  return hashId('repo', path.resolve(root));
}

/**
 * Cheap size signal for the repository, used as an estimation context factor.
 * Counts tracked-ish files with a hard cap so we never walk a huge tree.
 */
export function estimateRepoSize(root: string, cap = 20000): number {
  let count = 0;
  const skip = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'target',
    '.venv',
    'venv',
    '__pycache__',
    'Pods',
    'DerivedData',
    '.next',
    'vendor',
    '.terraform',
  ]);
  const walk = (dir: string, depth: number): void => {
    if (count >= cap || depth > 8) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count >= cap) return;
      if (e.name.startsWith('.') && e.name !== '.github') continue;
      if (e.isDirectory()) {
        if (skip.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        count++;
      }
    }
  };
  walk(root, 0);
  return count;
}
