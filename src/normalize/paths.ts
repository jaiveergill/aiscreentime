import path from 'node:path';

/**
 * Path heuristics used for anti-gaming and complexity signals.
 *
 * Generated, vendored, and lockfile paths are excluded from "code written"
 * signals: a 40,000-line `package-lock.json` diff is not engineering work, and
 * crediting it would make the headline number trivially inflatable.
 */

const GENERATED_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  'venv',
  'site-packages',
  'Pods',
  'DerivedData',
  '.terraform',
  'coverage',
  '.mypy_cache',
  '.pytest_cache',
  '.gradle',
  'bin',
  'obj',
  '.cache',
]);

const LOCKFILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lockb',
  'bun.lock',
  'Cargo.lock',
  'poetry.lock',
  'uv.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'Podfile.lock',
  'packages.lock.json',
  'flake.lock',
]);

const GENERATED_SUFFIXES = [
  '.min.js',
  '.min.css',
  '.map',
  '.pb.go',
  '.pb.cc',
  '.pb.h',
  '_pb2.py',
  '_pb2_grpc.py',
  '.g.dart',
  '.freezed.dart',
  '.generated.ts',
  '.gen.ts',
  '.d.ts.map',
  '.snap',
];

const BINARY_SUFFIXES = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp4',
  '.mov',
  '.mp3',
  '.wav',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
  '.bin',
  '.wasm',
  '.sqlite',
  '.db',
]);

const TEST_RE =
  /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e)(?:\/|$)|\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$|Tests?\.swift$/i;

const DOC_RE = /\.(?:md|mdx|rst|adoc|txt)$|(?:^|\/)docs?(?:\/|$)/i;

const CONFIG_RE =
  /(?:^|\/)(?:\.github|\.circleci|\.gitlab-ci\.yml|Dockerfile|docker-compose\.ya?ml|Makefile|\.env\.example|tsconfig[^/]*\.json|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|requirements[^/]*\.txt|\.eslintrc[^/]*|\.prettierrc[^/]*)$/i;

export function isGeneratedPath(p: string): boolean {
  const norm = p.replace(/\\/g, '/');
  const parts = norm.split('/');
  for (const part of parts) {
    if (GENERATED_DIRS.has(part)) return true;
  }
  const base = parts[parts.length - 1] ?? '';
  if (LOCKFILES.has(base)) return true;
  for (const s of GENERATED_SUFFIXES) if (base.endsWith(s)) return true;
  return false;
}

export function isBinaryPath(p: string): boolean {
  return BINARY_SUFFIXES.has(path.extname(p).toLowerCase());
}

export function isTestPath(p: string): boolean {
  return TEST_RE.test(p.replace(/\\/g, '/'));
}

export function isDocPath(p: string): boolean {
  return DOC_RE.test(p.replace(/\\/g, '/'));
}

export function isConfigPath(p: string): boolean {
  return CONFIG_RE.test(p.replace(/\\/g, '/'));
}

/**
 * Coarse subsystem key for a path: the first two meaningful directory segments
 * relative to the repo root. Used to count "how many parts of the system did
 * this touch", which is one of the strongest complexity signals we have.
 */
export function subsystemOf(filePath: string, repoRoot?: string): string {
  let rel = filePath.replace(/\\/g, '/');
  if (repoRoot) {
    const root = repoRoot.replace(/\\/g, '/').replace(/\/$/, '');
    if (rel.startsWith(`${root}/`)) rel = rel.slice(root.length + 1);
  }
  const parts = rel.split('/').filter((p) => p && p !== '.');
  if (parts.length <= 1) return '<root>';
  const skip = new Set(['src', 'lib', 'app', 'source', 'packages', 'apps']);
  const out: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (out.length === 0 && skip.has(p)) {
      out.push(p);
      continue;
    }
    out.push(p);
    if (out.length >= 2) break;
  }
  return out.join('/') || '<root>';
}

/** Language family of a path, used for prior selection and display. */
export function languageOf(p: string): string {
  const ext = path.extname(p).toLowerCase();
  switch (ext) {
    case '.ts':
    case '.tsx':
    case '.mts':
    case '.cts':
      return 'typescript';
    case '.js':
    case '.jsx':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.py':
      return 'python';
    case '.rs':
      return 'rust';
    case '.go':
      return 'go';
    case '.swift':
      return 'swift';
    case '.java':
    case '.kt':
      return 'jvm';
    case '.rb':
      return 'ruby';
    case '.php':
      return 'php';
    case '.c':
    case '.h':
    case '.cc':
    case '.cpp':
    case '.hpp':
      return 'c-family';
    case '.cs':
      return 'csharp';
    case '.sql':
      return 'sql';
    case '.sh':
    case '.bash':
    case '.zsh':
      return 'shell';
    case '.html':
    case '.css':
    case '.scss':
      return 'web';
    case '.yml':
    case '.yaml':
    case '.toml':
    case '.json':
      return 'config';
    default:
      return 'other';
  }
}

/** Migration-shaped paths signal an inherently higher-risk change. */
export function isMigrationPath(p: string): boolean {
  return /(?:^|\/)(?:migrations?|alembic|schema)(?:\/|$)|\.sql$/i.test(p.replace(/\\/g, '/'));
}

/** Infrastructure / deployment surface. */
export function isInfraPath(p: string): boolean {
  return /(?:^|\/)(?:\.github\/workflows|terraform|k8s|kubernetes|helm|deploy|infra|ansible)(?:\/|$)|Dockerfile|docker-compose|\.tf$/i.test(
    p.replace(/\\/g, '/'),
  );
}
