import type { TaskCategory } from '../core/types.ts';

/**
 * Empirical priors for counterfactual conventional engineering time.
 *
 * ## What these numbers are
 *
 * For each task category, `medianHours` is the time a competent engineer would
 * plausibly need — **without any generative-AI assistance** — to produce a
 * *typical* accepted outcome of that category, in a codebase they work in
 * regularly. `sigma` is the standard deviation of the underlying normal in a
 * lognormal model of effort.
 *
 * ## Why lognormal
 *
 * Software effort is consistently found to be right-skewed and approximately
 * lognormal: most tasks land near the median, a minority take far longer, and
 * none take negative time. Using a lognormal means we report a *range* whose
 * upper tail widens for genuinely uncertain categories (debugging) and stays
 * tight for mechanical ones (documentation), rather than pretending every
 * estimate has the same shape.
 *
 * ## Why these particular medians
 *
 * They are anchored to the small number of studies that actually timed
 * developers on real tasks, then adjusted per category by the relative effort
 * ordering that the estimation literature agrees on. The anchors are recorded
 * in `PRIOR_SOURCES` with their populations and limitations, and they are
 * genuinely limited: none of them measures "a reconstructed agent-mediated task
 * in this user's repository". They are starting distributions, deliberately
 * conservative, and they are meant to be replaced by the user's own calibration
 * data as it accumulates.
 *
 * ## What these numbers are not
 *
 * They are not a claim about economic value, headcount, or wages. They are not
 * derived from AI benchmark time horizons, which measure what a model can do
 * unaided and are not personal productivity accounting.
 */

export interface PriorSource {
  readonly id: string;
  readonly title: string;
  readonly citation: string;
  readonly population: string;
  readonly setting: string;
  readonly date: string;
  readonly finding: string;
  readonly limitations: string;
  readonly appliedTo: string;
}

export const PRIOR_SOURCES: PriorSource[] = [
  {
    id: 'metr-2025',
    title:
      'Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity',
    citation: 'METR, arXiv:2507.09089 (July 2025)',
    population:
      '16 experienced open-source developers, ~5 years average familiarity with the repository',
    setting:
      '246 real tasks in large, mature open-source repositories, randomised AI-allowed vs AI-disallowed',
    date: '2025-07',
    finding:
      'Developers took 19% LONGER with early-2025 AI tools than without. Task durations in the study clustered around a ~2 hour scale for issue-sized work in mature repositories. A 2026 follow-up estimated roughly +18% speedup but the authors flagged selection effects and revised the study design.',
    limitations:
      'Small n; mature repositories with high author familiarity; early-2025 tooling; measures interactive assistance, not delegated autonomous agents. Its headline result runs OPPOSITE to naive "AI is 10x" intuitions.',
    appliedTo:
      'Anchors the ~2 hour scale for issue-sized brownfield work, and is the reason this product does not apply any per-task speedup multiplier.',
  },
  {
    id: 'github-copilot-2024',
    title: "Quantifying GitHub Copilot's impact on developer productivity",
    citation: 'GitHub / Accenture controlled study, n=95 developers (2022–2024)',
    population: '95 professional developers',
    setting: 'Single standardised greenfield task: implement an HTTP server in JavaScript',
    date: '2024',
    finding:
      'The control group (no AI) took 2 hours 41 minutes; the assisted group took 1 hour 11 minutes (55.8% faster, 95% CI [21%, 89%]).',
    limitations:
      'One synthetic greenfield task, not representative of brownfield work; large confidence interval; vendor-run.',
    appliedTo:
      'Anchors the ~2.7 hour median for a self-contained greenfield feature built by an unassisted engineer.',
  },
  {
    id: 'effort-distribution',
    title: 'Distributional form of software development effort',
    citation:
      'Effort-estimation literature; lognormal and power-law-with-cutoff fits to productivity and activity-time data',
    population: 'Industrial and open-source software projects',
    setting: 'Task- and project-level effort records',
    date: '2016–2022',
    finding:
      'Lognormal consistently provides the best fit to software effort and activity-time data. Reported coefficient of variation of developer productivity averages ~0.55, with the top half of developers roughly 2.44× the productivity of the bottom half.',
    limitations:
      'Aggregate distributional evidence; does not fix the location parameter for any specific task type.',
    appliedTo:
      'Justifies modelling every estimate as a lognormal distribution and sets the floor on sigma (≥0.45) so no estimate claims false precision.',
  },
  {
    id: 'story-point-accuracy',
    title: 'Accuracy limits of expert task-duration estimation',
    citation:
      'Relative vs absolute estimation studies; story-point-to-duration correlation studies',
    population:
      '102 professional developers in one controlled comparison; open-source agile projects in others',
    setting: 'Estimating the same tasks in story points vs work-hours',
    date: '1998–2022',
    finding:
      'Expert task estimates are systematically optimistic and highly person-dependent; story points correlate only weakly with actual development time.',
    limitations: 'Shows what estimation gets wrong; does not supply better point estimates.',
    appliedTo:
      'Reason the product reports ranges rather than point values, treats user calibration as personal rather than universal, and never presents an estimate as exact.',
  },
];

export interface CategoryPrior {
  readonly category: TaskCategory;
  /** Median hours for a typical, moderately complex task in this category. */
  readonly medianHours: number;
  /** Sigma of the underlying normal. Larger = genuinely less predictable. */
  readonly sigma: number;
  /** Which source anchors this prior most directly. */
  readonly anchor: string;
  readonly rationale: string;
}

/**
 * Benchmark v1.
 *
 * Bump `BENCHMARK_VERSION` and add a new table whenever any number here
 * changes. Historical day metrics keep the version they were computed under and
 * are never silently rewritten.
 */
export const BENCHMARK_VERSION = 'v1.0.0';

export const CATEGORY_PRIORS: Record<TaskCategory, CategoryPrior> = {
  'feature-greenfield': {
    category: 'feature-greenfield',
    medianHours: 2.7,
    sigma: 0.62,
    anchor: 'github-copilot-2024',
    rationale:
      'Directly anchored to the unassisted control group time (2h41m) for building a self-contained feature from scratch.',
  },
  'feature-brownfield': {
    category: 'feature-brownfield',
    medianHours: 3.2,
    sigma: 0.68,
    anchor: 'metr-2025',
    rationale:
      'Issue-sized work in a mature repository ran on a ~2 hour scale; a full feature spans several such units, plus the cost of understanding surrounding code.',
  },
  debugging: {
    category: 'debugging',
    medianHours: 2.2,
    sigma: 0.9,
    anchor: 'effort-distribution',
    rationale:
      'Median is modest but the tail is long: the same symptom can resolve in ten minutes or consume a day. The widest sigma in the table.',
  },
  'incident-investigation': {
    category: 'incident-investigation',
    medianHours: 3.0,
    sigma: 0.95,
    anchor: 'effort-distribution',
    rationale:
      'Debugging under time pressure with unknown scope and cross-system evidence gathering.',
  },
  refactoring: {
    category: 'refactoring',
    medianHours: 2.6,
    sigma: 0.6,
    anchor: 'metr-2025',
    rationale:
      'Mechanically predictable per file but requires reading everything touched and re-verifying behaviour.',
  },
  migration: {
    category: 'migration',
    medianHours: 4.5,
    sigma: 0.75,
    anchor: 'effort-distribution',
    rationale:
      'Schema and framework migrations carry irreversible-change risk, dual-write concerns, and rollback planning that features do not.',
  },
  testing: {
    category: 'testing',
    medianHours: 1.8,
    sigma: 0.5,
    anchor: 'effort-distribution',
    rationale: 'Well-bounded work: the shape of the tests follows from code that already exists.',
  },
  'code-review': {
    category: 'code-review',
    medianHours: 1.0,
    sigma: 0.55,
    anchor: 'effort-distribution',
    rationale: 'Reading and reasoning, no implementation. Scales with diff size but stays bounded.',
  },
  research: {
    category: 'research',
    medianHours: 1.6,
    sigma: 0.7,
    anchor: 'effort-distribution',
    rationale:
      'Reading code, docs and prior art to reach a decision. Real work with a real outcome, but it produces understanding rather than shipped code — credited as its own category, never as implementation.',
  },
  documentation: {
    category: 'documentation',
    medianHours: 1.3,
    sigma: 0.5,
    anchor: 'effort-distribution',
    rationale: 'Predictable prose work over material that already exists.',
  },
  'project-setup': {
    category: 'project-setup',
    medianHours: 2.4,
    sigma: 0.65,
    anchor: 'github-copilot-2024',
    rationale:
      'Toolchain configuration is notoriously time-consuming per unit of code produced: much of it is trial and error against undocumented defaults.',
  },
  'dependency-tooling': {
    category: 'dependency-tooling',
    medianHours: 1.5,
    sigma: 0.8,
    anchor: 'effort-distribution',
    rationale:
      'Usually quick, occasionally a multi-day version-conflict spiral. Wide tail, low median.',
  },
  infrastructure: {
    category: 'infrastructure',
    medianHours: 3.0,
    sigma: 0.78,
    anchor: 'effort-distribution',
    rationale: 'Slow feedback loops: each iteration costs a deploy or pipeline run.',
  },
  'data-analysis': {
    category: 'data-analysis',
    medianHours: 2.0,
    sigma: 0.7,
    anchor: 'effort-distribution',
    rationale: 'Exploratory and iterative; effort is dominated by data shape discovery.',
  },
  performance: {
    category: 'performance',
    medianHours: 3.4,
    sigma: 0.85,
    anchor: 'effort-distribution',
    rationale:
      'Requires measurement before and after, and the first hypothesis is usually wrong. Heavy tail.',
  },
  security: {
    category: 'security',
    medianHours: 3.0,
    sigma: 0.8,
    anchor: 'effort-distribution',
    rationale: 'Demands careful reasoning about adversarial cases and a higher verification bar.',
  },
  'design-architecture': {
    category: 'design-architecture',
    medianHours: 2.6,
    sigma: 0.72,
    anchor: 'effort-distribution',
    rationale: 'Thinking and writing rather than coding; bounded by decision scope.',
  },
  maintenance: {
    category: 'maintenance',
    medianHours: 1.0,
    sigma: 0.55,
    anchor: 'effort-distribution',
    rationale:
      'Small, well-understood chores in familiar code: version bumps, copyright headers, dead-code removal. Predictable, and rarely the thing that takes a day.',
  },
  'failed-exploration': {
    category: 'failed-exploration',
    medianHours: 1.2,
    sigma: 0.8,
    anchor: 'effort-distribution',
    rationale:
      'A conventional engineer would also have spent real time down this path. Credited at a low median and then heavily discounted by the completion and verification factors, so failed work contributes little.',
  },
};

/** Categories that produce understanding rather than shipped implementation. */
export const NON_IMPLEMENTATION_CATEGORIES = new Set<TaskCategory>([
  'research',
  'code-review',
  'design-architecture',
  'failed-exploration',
]);
