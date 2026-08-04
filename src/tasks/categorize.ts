import type { TaskCategory, TaskEvidence } from '../core/types.ts';
import {
  isConfigPath,
  isDocPath,
  isInfraPath,
  isMigrationPath,
  isTestPath,
} from '../normalize/paths.ts';

/**
 * Task categorisation from instruction text plus structural evidence.
 *
 * Structure beats text: a task whose only changed files are under `tests/` is
 * testing work regardless of how the prompt was phrased, and a task that
 * changed nothing but read twenty files is research regardless of the verb the
 * user used. Text is used to break ties and to separate greenfield from
 * brownfield feature work.
 */

interface Signal {
  readonly category: TaskCategory;
  readonly re: RegExp;
  readonly weight: number;
}

const TEXT_SIGNALS: Signal[] = [
  {
    category: 'debugging',
    re: /\b(?:bug|broken|failing|fails?|crash(?:e[sd])?|error|exception|traceback|stack ?trace|doesn'?t work|not working|regression|flaky)\b/i,
    weight: 3,
  },
  {
    category: 'incident-investigation',
    re: /\b(?:incident|outage|is down|went down|production (?:issue|incident|outage)|sev\d|post-?mortem|paged?|on-?call)\b/i,
    weight: 4,
  },
  {
    category: 'refactoring',
    re: /\b(?:refactor|clean ?up|tidy|restructure|extract|rename|simplif|deduplicat|dry it up|reorganiz)\b/i,
    weight: 3,
  },
  {
    category: 'migration',
    re: /\b(?:migrat|upgrade to|port to|move (?:from|off)|backfill|schema change|convert .* to)\b/i,
    weight: 3,
  },
  {
    category: 'testing',
    re: /\b(?:write tests?|add tests?|unit tests?|integration tests?|test coverage|regression tests?)\b/i,
    weight: 2,
  },
  {
    category: 'code-review',
    re: /\b(?:review (?:this|the|my) (?:pr|diff|code|change)|code review|pr review|critique)\b/i,
    weight: 4,
  },
  {
    category: 'research',
    re: /\b(?:research|investigate|explore|understand|how does|explain|figure out|look into|survey|compare (?:options|approaches)|what (?:is|are))\b/i,
    weight: 2,
  },
  {
    category: 'documentation',
    re: /\b(?:document|docs?|readme|changelog|write.*(?:guide|tutorial)|api reference)\b/i,
    weight: 3,
  },
  {
    category: 'project-setup',
    re: /\b(?:scaffold|bootstrap|set ?up (?:a|the) (?:project|repo)|initiali[sz]e|new project|from scratch)\b/i,
    weight: 3,
  },
  {
    category: 'dependency-tooling',
    re: /\b(?:dependenc|upgrade (?:package|lib)|bump|lockfile|npm install|package\.json|tooling|linter|formatter|eslint|prettier)\b/i,
    weight: 3,
  },
  {
    category: 'infrastructure',
    re: /\b(?:deploy|ci\/?cd|pipeline|docker|kubernetes|k8s|terraform|infra|hosting|nginx|github actions?)\b/i,
    weight: 3,
  },
  {
    category: 'data-analysis',
    re: /\b(?:analy[sz]e|dataset|dataframe|notebook|statistics|chart|plot|aggregate|query the data)\b/i,
    weight: 3,
  },
  {
    category: 'performance',
    re: /\b(?:performance|optimi[sz]|slow|latency|speed ?up|profil|bottleneck|memory (?:leak|usage)|n\+1)\b/i,
    weight: 4,
  },
  {
    category: 'security',
    re: /\b(?:security|vulnerab|cve|exploit|sanitiz|xss|csrf|sql ?injection|auth(?:oriz|enticat)|secret|credential)\b/i,
    weight: 4,
  },
  {
    category: 'design-architecture',
    re: /\b(?:architect|design (?:doc|the system)|adr|trade-?offs?|plan (?:the|out)|approach for)\b/i,
    weight: 2,
  },
  {
    category: 'maintenance',
    re: /\b(?:maintenance|chore|tidy|update copyright|bump version|housekeeping)\b/i,
    weight: 2,
  },
  {
    category: 'feature-greenfield',
    re: /\b(?:build|create|implement|add) (?:a |an |the )?(?:new |brand new )?(?:feature|page|screen|endpoint|service|app|component|module|tool)\b/i,
    weight: 2,
  },
];

export interface CategorizeInput {
  readonly text: string;
  readonly evidence: TaskEvidence;
  readonly paths: readonly string[];
  /** Fraction of changed lines that landed in files that already existed. */
  readonly brownfieldRatio: number;
  /** Repository already contained substantial code before this task. */
  readonly repoIsMature: boolean;
}

export interface CategorizeResult {
  readonly category: TaskCategory;
  readonly confidence: number;
  readonly reasons: string[];
}

export function categorize(input: CategorizeInput): CategorizeResult {
  const scores = new Map<TaskCategory, number>();
  const reasons: string[] = [];
  const bump = (c: TaskCategory, w: number, why: string): void => {
    scores.set(c, (scores.get(c) ?? 0) + w);
    if (w >= 3) reasons.push(why);
  };

  // --- text signals -------------------------------------------------------
  for (const s of TEXT_SIGNALS) {
    if (s.re.test(input.text)) bump(s.category, s.weight, `instruction mentions ${s.category}`);
  }

  // --- structural signals -------------------------------------------------
  const ev = input.evidence;
  const paths = input.paths;
  const total = paths.length || 1;
  const testShare = paths.filter(isTestPath).length / total;
  const docShare = paths.filter(isDocPath).length / total;
  const infraShare = paths.filter(isInfraPath).length / total;
  const configShare = paths.filter(isConfigPath).length / total;
  const migrationShare = paths.filter(isMigrationPath).length / total;

  if (testShare > 0.6 && paths.length > 0) bump('testing', 6, 'most changed files are tests');
  else if (testShare > 0 && testShare <= 0.5 && paths.length > 1) {
    // Tests written alongside a feature are part of the feature, not the task.
    scores.set('testing', (scores.get('testing') ?? 0) - 2);
  }
  if (docShare > 0.7 && paths.length > 0) bump('documentation', 6, 'most changed files are docs');
  if (infraShare > 0.5 && paths.length > 0)
    bump('infrastructure', 5, 'most changed files are infra');
  if (migrationShare > 0.4 && paths.length > 0) bump('migration', 5, 'migration files changed');
  if (configShare > 0.7 && paths.length > 0 && paths.length <= 4) {
    bump('dependency-tooling', 4, 'only config files changed');
  }

  // No files written at all: this was reading, not building.
  if (ev.filesChanged === 0) {
    if (ev.userInstructions > 0 && (ev.toolCalls > 3 || ev.researchArtifacts > 0)) {
      bump('research', 6, 'no files were modified; work was exploration');
    }
  }

  // A long error-resolution sequence is debugging, whatever the prompt said.
  if (ev.errorsEncountered >= 3 && ev.filesChanged > 0 && ev.linesAdded < 400) {
    bump('debugging', 4, `${ev.errorsEncountered} errors encountered during the task`);
  }

  // Roughly balanced add/remove with no new files is a refactor shape.
  if (
    ev.filesAdded === 0 &&
    ev.linesAdded > 0 &&
    ev.linesRemoved > 0 &&
    Math.abs(ev.linesAdded - ev.linesRemoved) / Math.max(ev.linesAdded, ev.linesRemoved) < 0.35 &&
    ev.filesChanged >= 2
  ) {
    bump('refactoring', 3, 'balanced additions and deletions across existing files');
  }

  // Everything failed and nothing survived.
  if (ev.filesChanged > 0 && ev.filesMissing > 0 && ev.filesStillPresent === 0) {
    bump('failed-exploration', 5, 'no changed file survives in the working tree');
  }

  // --- greenfield vs brownfield ------------------------------------------
  if (ev.filesChanged > 0) {
    const greenfield = !input.repoIsMature || ev.filesAdded / Math.max(1, ev.filesChanged) > 0.6;
    if (greenfield && input.brownfieldRatio < 0.4) {
      bump('feature-greenfield', 2, 'mostly new files in a young codebase');
    } else {
      bump('feature-brownfield', 2, 'changes land in existing code');
    }
  }

  let best: TaskCategory = ev.filesChanged > 0 ? 'feature-brownfield' : 'research';
  let bestScore = 0;
  let second = 0;
  for (const [c, s] of scores) {
    if (s > bestScore) {
      second = bestScore;
      bestScore = s;
      best = c;
    } else if (s > second) {
      second = s;
    }
  }

  // Confidence blends how much evidence there is with how cleanly it points at
  // one category. Margin alone is wrong: a single weak signal has a perfect
  // margin but tells us almost nothing, and would otherwise out-score a strong
  // signal that merely had a runner-up.
  const strength = Math.min(1, bestScore / 8);
  const margin = bestScore === 0 ? 0 : (bestScore - second) / (bestScore + second + 2);
  const confidence = bestScore === 0 ? 0.2 : Math.min(0.95, 0.2 + 0.5 * strength + 0.3 * margin);

  return { category: best, confidence, reasons: reasons.slice(0, 5) };
}

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  'feature-greenfield': 'New feature (greenfield)',
  'feature-brownfield': 'Feature in existing code',
  debugging: 'Debugging',
  'incident-investigation': 'Incident investigation',
  refactoring: 'Refactoring',
  migration: 'Migration',
  testing: 'Testing',
  'code-review': 'Code review',
  research: 'Research & exploration',
  documentation: 'Documentation',
  'project-setup': 'Project setup',
  'dependency-tooling': 'Dependencies & tooling',
  infrastructure: 'Infrastructure & deployment',
  'data-analysis': 'Data analysis',
  performance: 'Performance',
  security: 'Security',
  'design-architecture': 'Design & architecture',
  maintenance: 'Maintenance',
  'failed-exploration': 'Failed / abandoned exploration',
};
