#!/usr/bin/env node
// Entry point.
//
// Prefers the compiled build, but falls back to running TypeScript directly via
// Node's built-in type stripping (Node 22.18+ / 23.6+ / 24+). If the source is
// newer than the build, the source wins — a stale `dist/` silently serving old
// behaviour after a `git pull` is a genuinely confusing failure mode.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const compiled = path.join(root, 'dist', 'cli', 'main.js');
const source = path.join(root, 'src', 'cli', 'main.ts');

const [major, minor] = process.versions.node.split('.').map(Number);
const stripsTypes = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18);

/** Newest mtime of any .ts under a directory, for a cheap staleness check. */
function newestMtime(dir, depth = 0) {
  if (depth > 6) return 0;
  let newest = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'ui') continue; // bundled separately, not part of dist/
      newest = Math.max(newest, newestMtime(full, depth + 1));
    } else if (e.name.endsWith('.ts')) {
      try {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      } catch {
        /* ignore unreadable entries */
      }
    }
  }
  return newest;
}

let entry;
if (fs.existsSync(compiled)) {
  let stale = false;
  try {
    stale = newestMtime(path.join(root, 'src')) > fs.statSync(compiled).mtimeMs;
  } catch {
    stale = false;
  }
  if (stale && stripsTypes) {
    if (process.env.SCREENTIME_QUIET !== '1') {
      process.stderr.write(
        '[2mscreentime: dist/ is older than src/, running from source. Run `npm run build` to refresh it.[0m\n',
      );
    }
    entry = source;
  } else {
    entry = compiled;
  }
} else if (stripsTypes) {
  entry = source;
} else {
  console.error(
    `AI Screen Time needs Node 22.18+ to run from source, or a build.\n` +
      `You have ${process.versions.node}. Run "npm run build" or upgrade Node.`,
  );
  process.exit(1);
}

const mod = await import(entry);
process.exitCode = await mod.main(process.argv.slice(2));
