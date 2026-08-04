#!/usr/bin/env node
/**
 * Project linter.
 *
 * Enforces the invariants this codebase actually depends on, which a generic
 * rule set would not know about:
 *
 *  1. Node's type stripping rejects parameter properties, enums and namespaces.
 *     Using them breaks `leverage` when run from source.
 *  2. Nothing outside `src/git/git.ts` may spawn `git`, and nothing anywhere may
 *     write to a provider's data directory. Read-only access to agent files is
 *     a product promise, not a convention.
 *  3. `any` defeats the strict typing the estimation layer relies on.
 *  4. Relative imports must carry the `.ts` extension for NodeNext resolution.
 *  5. Only the CLI writes to stdout; everything else uses the structured logger.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', 'dist', 'public', '.git'].includes(e.name)) continue;
      walk(full, out);
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs')) {
      out.push(full);
    }
  }
  return out;
}

const files = [
  ...walk(path.join(root, 'src')),
  ...walk(path.join(root, 'test')),
  ...walk(path.join(root, 'scripts')),
];

/** Strip line and block comments so rules do not fire on prose. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

const RULES = [
  {
    id: 'no-parameter-properties',
    why: "Node's type stripping cannot handle parameter properties.",
    // The modifier must begin a parameter, i.e. follow "(" or ",". Otherwise
    // an ordinary `readonly string[]` parameter type trips the rule.
    test: (code) =>
      [...code.matchAll(/constructor\s*\(([\s\S]*?)\)/g)].filter((m) =>
        /(?:^|[(,])\s*(?:private|public|protected|readonly)\s+\w/.test(m[1]),
      ),
  },
  {
    id: 'no-enums',
    why: "Node's type stripping cannot handle enums. Use a union of string literals.",
    test: (code) => [...code.matchAll(/^\s*(?:export\s+)?(?:const\s+)?enum\s+\w+/gm)],
  },
  {
    id: 'no-namespaces',
    why: "Node's type stripping cannot handle namespaces.",
    test: (code) => [...code.matchAll(/^\s*(?:export\s+)?namespace\s+\w+/gm)],
  },
  {
    id: 'no-any',
    why: 'Use `unknown` and narrow, so the estimation layer stays strictly typed.',
    test: (code) => [...code.matchAll(/:\s*any\b|<any>|\bas\s+any\b/g)],
    exempt: (file) =>
      file.includes(`${path.sep}test${path.sep}`) || file.includes(`${path.sep}scripts${path.sep}`),
  },
  {
    id: 'relative-imports-need-ts-extension',
    why: 'NodeNext resolution requires an explicit extension on relative imports.',
    test: (code) =>
      [...code.matchAll(/from\s+'(\.[^']*?)'/g)].filter(
        (m) => !/\.(ts|mjs|js|json|css)$/.test(m[1]),
      ),
  },
  {
    id: 'no-stdout-outside-cli',
    why: 'Use the structured logger; only the CLI writes to stdout.',
    test: (code) => [...code.matchAll(/console\.(log|info|warn|error)\s*\(/g)],
    exempt: (file) =>
      file.includes(`${path.sep}cli${path.sep}`) ||
      file.includes(`${path.sep}scripts${path.sep}`) ||
      file.includes(`${path.sep}test${path.sep}`) ||
      file.includes(`${path.sep}ui${path.sep}`),
  },
  {
    id: 'git-only-through-the-git-module',
    why: 'All Git access must go through src/git/git.ts, which enforces a read-only allowlist.',
    test: (code) => [
      ...code.matchAll(/spawnSync\s*\(\s*['"]git['"]|exec(?:Sync)?\s*\(\s*['"`]git\s/g),
    ],
    exempt: (file) =>
      file.endsWith(path.join('src', 'git', 'git.ts')) ||
      file.includes(`${path.sep}test${path.sep}`),
  },
  {
    id: 'never-write-to-provider-directories',
    why: 'Leverage must never modify Claude Code or Codex files.',
    test: (code) =>
      [
        ...code.matchAll(
          /fs\.(?:writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rename|renameSync|truncate|truncateSync)\s*\(([^,)]*)/g,
        ),
      ].filter((m) => /\.claude|\.codex|CLAUDE_CONFIG_DIR|CODEX_HOME/.test(m[1])),
    exempt: (file) => file.includes(`${path.sep}test${path.sep}`),
  },
  {
    id: 'no-literal-credentials',
    why: 'Compose test credentials at runtime; literals trip secret scanners and block pushes.',
    test: (code) => [
      ...code.matchAll(
        /(?:sk-ant-api\d{2}-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9]{10,}-[A-Za-z0-9]{10,}|AIzaSy[A-Za-z0-9_-]{30,}|sk_live_[A-Za-z0-9]{20,})/g,
      ),
    ],
  },
  {
    id: 'no-focused-tests',
    why: 'A committed `.only` silently skips the rest of the suite.',
    test: (code) => [...code.matchAll(/\b(?:test|describe|it)\.only\s*\(/g)],
  },
];

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8');
  const code = stripComments(raw);
  const rel = path.relative(root, file);
  for (const rule of RULES) {
    if (rule.exempt?.(file)) continue;
    for (const m of rule.test(code)) {
      const line = code.slice(0, m.index).split('\n').length;
      problems.push({
        file: rel,
        line,
        rule: rule.id,
        why: rule.why,
        snippet: m[0].trim().slice(0, 70),
      });
    }
  }
}

// Structural checks that are not per-file.
const publicDir = path.join(root, 'public');
if (fs.existsSync(path.join(publicDir, 'index.html'))) {
  const html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  if (/https?:\/\/(?!www\.w3\.org)/.test(html)) {
    problems.push({
      file: 'public/index.html',
      line: 1,
      rule: 'no-external-resources',
      why: 'The dashboard must be fully self-contained so the strict CSP holds.',
      snippet: 'external URL in index.html',
    });
  }
}

if (problems.length === 0) {
  console.log(`lint: ${files.length} files, no problems`);
  process.exit(0);
}

const byRule = new Map();
for (const p of problems) {
  if (!byRule.has(p.rule)) byRule.set(p.rule, []);
  byRule.get(p.rule).push(p);
}
for (const [rule, list] of byRule) {
  console.error(`\n✖ ${rule} — ${list[0].why}`);
  for (const p of list.slice(0, 12)) console.error(`    ${p.file}:${p.line}  ${p.snippet}`);
  if (list.length > 12) console.error(`    …and ${list.length - 12} more`);
}
console.error(`\nlint: ${problems.length} problem(s) in ${byRule.size} rule(s)\n`);
process.exit(1);
