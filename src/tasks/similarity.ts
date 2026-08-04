/**
 * Lightweight lexical similarity.
 *
 * Deliberately not embeddings: task grouping must work with no API key, no
 * model download, and no data leaving the machine. Token-overlap similarity is
 * weaker than semantic embeddings but it is transparent, deterministic, fast,
 * and good enough to decide "is this prompt continuing the same piece of work?"
 * when combined with the much stronger signals of shared files and time
 * proximity. The optional semantic layer refines these groupings when enabled.
 */

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'if',
  'then',
  'so',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'with',
  'by',
  'from',
  'as',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'my',
  'your',
  'our',
  'their',
  'me',
  'us',
  'them',
  'do',
  'does',
  'did',
  'can',
  'could',
  'should',
  'would',
  'will',
  'shall',
  'may',
  'might',
  'must',
  'have',
  'has',
  'had',
  'not',
  'no',
  'yes',
  'ok',
  'okay',
  'please',
  'now',
  'also',
  'just',
  'only',
  'more',
  'most',
  'some',
  'any',
  'all',
  'then',
  'when',
  'where',
  'what',
  'which',
  'who',
  'how',
  'why',
  'there',
  'here',
  'out',
  'up',
  'down',
  'into',
  'over',
  'again',
  'still',
  'let',
  'lets',
  'make',
  'made',
  'get',
  'got',
  'use',
  'using',
  'used',
  'need',
  'needs',
  'want',
  'like',
  'see',
  'look',
  'go',
  'going',
  'run',
  'add',
  'added',
  'fix',
  'fixed',
  'file',
  'files',
  'code',
]);

/** Words that carry engineering meaning and should be weighted higher. */
const DOMAIN_HINTS = new Set([
  'auth',
  'authentication',
  'login',
  'logout',
  'password',
  'token',
  'session',
  'database',
  'schema',
  'migration',
  'migrate',
  'api',
  'endpoint',
  'route',
  'handler',
  'component',
  'ui',
  'ux',
  'render',
  'parser',
  'parse',
  'test',
  'tests',
  'bug',
  'error',
  'crash',
  'refactor',
  'rename',
  'extract',
  'deploy',
  'build',
  'pipeline',
  'cache',
  'caching',
  'performance',
  'latency',
  'memory',
  'leak',
  'security',
  'vulnerability',
  'docs',
  'documentation',
  'readme',
  'config',
  'settings',
  'webhook',
  'queue',
  'worker',
  'index',
  'query',
  'sql',
  'model',
  'type',
  'types',
  'interface',
  'validation',
  'validate',
  'upload',
  'download',
  'export',
  'import',
  'sync',
  'async',
  'concurrency',
  'race',
  'lock',
  'retry',
  'timeout',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9_/.-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && t.length <= 40 && !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

/** Weighted token set: domain terms and path-like tokens count double. */
export function tokenWeights(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tokenize(text)) {
    const w = DOMAIN_HINTS.has(t) || t.includes('/') || t.includes('.') ? 2 : 1;
    out.set(t, (out.get(t) ?? 0) + w);
  }
  return out;
}

/** Weighted Jaccard similarity in [0, 1]. */
export function similarity(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  let union = 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    inter += Math.min(x, y);
    union += Math.max(x, y);
  }
  return union === 0 ? 0 : inter / union;
}

export function textSimilarity(a: string, b: string): number {
  return similarity(tokenWeights(a), tokenWeights(b));
}

/**
 * Weighted containment: how much of the *shorter* text's vocabulary appears in
 * the longer one.
 *
 * Jaccard punishes length asymmetry, which is exactly the shape of a follow-up
 * instruction ("finish the orders currency migration") against the original
 * ask. Containment answers the question we actually care about — "is this
 * talking about the same thing?" — without being diluted by the longer text.
 */
export function containment(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  let smallTotal = 0;
  for (const [k, v] of small) {
    smallTotal += v;
    inter += Math.min(v, large.get(k) ?? 0);
  }
  return smallTotal === 0 ? 0 : inter / smallTotal;
}

export function textContainment(a: string, b: string): number {
  return containment(tokenWeights(a), tokenWeights(b));
}

/** Overlap coefficient of two path sets, normalised by the smaller set. */
export function pathOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const p of small) if (large.has(p)) inter++;
  return inter / small.size;
}

/**
 * Compress an instruction into a short human title.
 *
 * Strips markdown, harness noise, and slash-command wrappers, then takes the
 * first clause. Titles are display-only and never affect estimation.
 */
export function deriveTitle(text: string, max = 72): string {
  let t = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*[-*#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const cmd = /^\/([a-z-]+)/.exec(t);
  if (cmd?.[1]) t = t.replace(/^\/[a-z-]+\s*/, `${cmd[1]}: `);
  // Prefer the first sentence or clause.
  const stop = t.search(/[.!?\n]|\s-\s/);
  if (stop > 12) t = t.slice(0, stop);
  t = t.trim();
  if (t.length === 0) return 'Untitled work';
  if (t.length > max) t = `${t.slice(0, max - 1).trimEnd()}…`;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
