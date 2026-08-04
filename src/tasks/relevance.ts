import type { NormalizedEvent } from '../core/types.ts';
import { isBinaryPath, languageOf } from '../normalize/paths.ts';
import type { TaskSegment } from './reconstruct.ts';

/**
 * Engineering-relevance gate.
 *
 * Coding agents are general assistants. Real transcripts contain plenty of work
 * that is not software engineering at all: drafting emails, answering personal
 * questions, summarising a web page, chatting. None of that has a
 * "counterfactual conventional engineering time", and crediting it would turn
 * the headline into a vanity metric — which is precisely the failure mode this
 * product exists to avoid.
 *
 * This gate requires positive, structural evidence that a segment is software
 * engineering before it can become a task. It is deliberately strict: the cost
 * of wrongly excluding a small task is a slightly lower number, while the cost
 * of wrongly including chat is a number nobody should believe.
 *
 * Rejected segments are counted and surfaced in the diagnostics view, never
 * silently dropped.
 */

export type RelevanceVerdict = 'engineering' | 'non-engineering';

export interface RelevanceResult {
  readonly verdict: RelevanceVerdict;
  readonly score: number;
  readonly signals: string[];
  readonly reason: string;
}

/** Minimum score to be treated as engineering work. */
export const RELEVANCE_THRESHOLD = 4;

const TECHNICAL_TERMS =
  /\b(?:function|class|method|variable|component|module|package|library|framework|api|endpoint|route|schema|database|query|migration|repository|repo|commit|branch|merge|pull request|typescript|javascript|python|rust|golang|swift|kotlin|java|sql|html|css|react|vue|svelte|node|npm|pnpm|yarn|cargo|pytest|jest|vitest|docker|kubernetes|terraform|compile|build|deploy|refactor|debug|stack ?trace|exception|null pointer|segfault|lint|typecheck|unit test|integration test|regression|codebase|implementation|interface|struct|enum|async|await|promise|thread|mutex|cache|index|latency|throughput|bug|patch|diff|merge conflict)\b/i;

const CODE_SHAPE =
  /```|\bdef \w+\(|\bfunction \w+\(|\bclass \w+\b|=>\s*\{|\bimport .* from\b|#include|\bSELECT .* FROM\b/i;

/** Tools whose use is itself evidence of engineering work. */
const ENGINEERING_TOOLS = new Set([
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Grep',
  'Glob',
  'NotebookEdit',
  'exec_command',
  'apply_patch',
  'exec',
  'shell',
  'write_stdin',
]);

export function assessRelevance(seg: TaskSegment, repoIsGit: boolean): RelevanceResult {
  let score = 0;
  const signals: string[] = [];
  const add = (n: number, why: string): void => {
    score += n;
    signals.push(why);
  };

  // --- structural evidence (strongest) ------------------------------------
  let codeFilesTouched = 0;
  let anyFileTouched = 0;
  let shellCommands = 0;
  let verificationRuns = 0;
  let codeReads = 0;
  let engineeringToolCalls = 0;
  let searches = 0;

  for (const e of seg.events) {
    switch (e.kind) {
      case 'file.created':
      case 'file.modified':
      case 'file.deleted':
        for (const f of e.payload.files ?? []) {
          anyFileTouched++;
          if (!f.generated && !isBinaryPath(f.path) && languageOf(f.path) !== 'other')
            codeFilesTouched++;
        }
        break;
      case 'shell.command':
        shellCommands++;
        break;
      case 'test.run':
      case 'build.run':
      case 'lint.run':
      case 'typecheck.run':
        verificationRuns++;
        break;
      case 'file.read':
        for (const p of e.payload.paths ?? []) {
          if (languageOf(p) !== 'other') codeReads++;
        }
        break;
      case 'search.performed':
        searches++;
        break;
      default:
        break;
    }
    if (e.payload.toolName && ENGINEERING_TOOLS.has(e.payload.toolName)) engineeringToolCalls++;
  }

  if (codeFilesTouched > 0) add(5, `${codeFilesTouched} source file(s) changed`);
  else if (anyFileTouched > 0) add(2, `${anyFileTouched} non-source file(s) changed`);

  if (verificationRuns > 0) add(4, `${verificationRuns} test/build/lint run(s)`);
  if (shellCommands >= 3) add(3, `${shellCommands} shell commands executed`);
  else if (shellCommands > 0) add(1, `${shellCommands} shell command(s)`);

  if (codeReads >= 2) add(2, `${codeReads} source file(s) read`);
  if (engineeringToolCalls >= 5) add(2, `${engineeringToolCalls} engineering tool calls`);

  // --- context ------------------------------------------------------------
  if (repoIsGit) add(2, 'work happened inside a Git repository');

  // --- language evidence (weakest, and never sufficient alone) ------------
  const text = seg.instructionText;
  if (text.length > 0) {
    if (CODE_SHAPE.test(text)) add(2, 'instruction contains code');
    else if (TECHNICAL_TERMS.test(text)) add(1, 'instruction uses software-engineering vocabulary');
  }
  if (searches >= 3 && (codeReads > 0 || repoIsGit))
    add(1, 'repeated technical searches in a code context');

  const verdict: RelevanceVerdict =
    score >= RELEVANCE_THRESHOLD ? 'engineering' : 'non-engineering';
  const reason =
    verdict === 'engineering'
      ? `Scored ${score}/${RELEVANCE_THRESHOLD} on engineering evidence.`
      : `Scored ${score}/${RELEVANCE_THRESHOLD}: no source files were changed, no commands ran, and no repository was involved. Treated as non-engineering assistant use and excluded from all totals.`;

  return { verdict, score, signals, reason };
}

/**
 * Depth of a research/exploration task.
 *
 * Genuine codebase research — reading twenty files to understand a subsystem —
 * is real work. A single question answered in one turn is not. This returns a
 * multiplier used by the estimator so that research credit tracks the actual
 * depth of the investigation instead of a flat category prior.
 */
export function researchDepthMultiplier(events: readonly NormalizedEvent[]): {
  multiplier: number;
  artifacts: number;
} {
  let artifacts = 0;
  for (const e of events) {
    if (e.kind === 'file.read') artifacts += 1;
    else if (e.kind === 'search.performed') artifacts += 1;
    else if (e.kind === 'web.fetched') artifacts += 1;
    else if (e.kind === 'shell.command') artifacts += 0.5;
    else if (e.kind === 'tool.invoked') artifacts += 0.25;
  }
  // 0 artifacts → 0.25×; ~8 → 1.0×; 40 → ~1.5×.
  const multiplier = Math.min(1.5, Math.max(0.25, 0.25 + 0.25 * Math.log2(1 + artifacts)));
  return { multiplier, artifacts };
}
