import type {
  ConfidenceLevel,
  EffortDistribution,
  EstimateMode,
  EstimationFactor,
  TaskCategory,
  TaskEstimate,
  TaskEvidence,
} from '../core/types.ts';
import { clamp } from '../core/util.ts';
import { BENCHMARK_VERSION, CATEGORY_PRIORS, NON_IMPLEMENTATION_CATEGORIES } from './priors.ts';
import type { VerificationResult } from '../verify/outcome.ts';

/**
 * Counterfactual conventional engineering-time estimation.
 *
 * ## The question
 *
 * For each reconstructed task: how long would a competent engineer, without
 * generative-AI assistance, likely have needed to produce the **same accepted
 * and verified outcome** in the same repository context?
 *
 * ## The method
 *
 * A category prior supplies a lognormal starting distribution. Bounded,
 * explicitly-named multipliers adjust its median based on structural evidence.
 * The result is then scaled twice — by completion, then by verification — to
 * produce three distinct quantities that the UI never conflates:
 *
 *   gross     → the effort the *intended* outcome would have required
 *   accepted  → gross × completionFactor    (what was actually produced)
 *   verified  → accepted × verificationFactor (what we can stand behind)
 *
 * The headline uses `verified`.
 *
 * ## What is deliberately not done
 *
 * The estimate is never token count × k, lines × k, runtime × k, or prompts × k.
 * Those quantities appear only as *bounded, sublinear complexity signals*: a
 * task with 5,000 changed lines is credited more than one with 50, but nowhere
 * near 100× more, because the relationship between diff size and engineering
 * effort is famously weak and trivially gameable.
 */

const MODE_MULTIPLIER: Record<EstimateMode, number> = {
  /** Default, and the only mode used for share cards. */
  conservative: 0.8,
  balanced: 1.0,
  /** Upper end of a defensible range. Never called "aggressive". */
  'upper-range': 1.25,
};

export interface EstimateInput {
  readonly taskId: string;
  readonly category: TaskCategory;
  readonly categoryConfidence: number;
  readonly evidence: TaskEvidence;
  readonly verification: VerificationResult;
  readonly mode: EstimateMode;
  /** Rough file count of the repository, if known. */
  readonly repoFileCount?: number;
  readonly repoIsGit: boolean;
  /** Distinct languages touched. */
  readonly languageCount: number;
  /** Task touches migration-shaped paths. */
  readonly touchesMigration: boolean;
  /** Task touches infrastructure/deployment paths. */
  readonly touchesInfra: boolean;
  /** Personal calibration multiplier, if the user has calibrated this category. */
  readonly calibration?: CalibrationAdjustment;
  /** Structured output of the optional semantic layer. */
  readonly semantic?: SemanticAdjustment;
  /** How deep the investigation actually went, for exploration-shaped tasks. */
  readonly researchDepth?: { multiplier: number; artifacts: number };
  /** User's explicit hour override. Wins over everything. */
  readonly userOverrideHours?: number;
}

export interface CalibrationAdjustment {
  readonly multiplier: number;
  readonly sampleSize: number;
  readonly categoryMatched: boolean;
}

export interface SemanticAdjustment {
  /** Bounded multiplier the model suggested, already clamped by the caller. */
  readonly complexityMultiplier: number;
  /** Fraction of the output judged to be routine boilerplate, in [0, 1]. */
  readonly boilerplateFraction: number;
  readonly rationale: string;
  readonly model: string;
}

// ---------------------------------------------------------------------------
// Lognormal helpers
// ---------------------------------------------------------------------------

const ACKLAM_A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
  -3.066479806614716e1, 2.506628277459239,
] as const;
const ACKLAM_B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
  -1.328068155288572e1,
] as const;
const ACKLAM_C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
  4.374664141464968, 2.938163982698783,
] as const;
const ACKLAM_D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416,
] as const;

function poly(coeffs: readonly number[], x: number): number {
  let acc = 0;
  for (const c of coeffs) acc = acc * x + c;
  return acc;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation).
 * Absolute relative error below 1.15e-9 across the full range — far tighter
 * than anything this model's inputs justify.
 */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) throw new RangeError('probit requires 0 < p < 1');
  const pLow = 0.02425;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  }
  if (p > 1 - pLow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -poly(ACKLAM_C, q) / (poly(ACKLAM_D, q) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (poly(ACKLAM_A, r) * q) / (poly(ACKLAM_B, r) * r + 1);
}

const Z10 = probit(0.1);
const Z90 = probit(0.9);

export function lognormal(medianHours: number, sigma: number): EffortDistribution {
  const median = Math.max(0, medianHours);
  const s = Math.max(0.05, sigma);
  if (median === 0) return { median: 0, sigma: s, p10: 0, p50: 0, p90: 0, mean: 0 };
  const mu = Math.log(median);
  return {
    median,
    sigma: s,
    p10: Math.exp(mu + Z10 * s),
    p50: median,
    p90: Math.exp(mu + Z90 * s),
    mean: Math.exp(mu + (s * s) / 2),
  };
}

export function scaleDistribution(d: EffortDistribution, k: number): EffortDistribution {
  const f = Math.max(0, k);
  return {
    median: d.median * f,
    sigma: d.sigma,
    p10: d.p10 * f,
    p50: d.p50 * f,
    p90: d.p90 * f,
    mean: d.mean * f,
  };
}

/**
 * Sum independent lognormals.
 *
 * Exact for the mean; the variance sum is exact under independence, and the
 * result is re-expressed as the lognormal with matching mean and variance
 * (Fenton–Wilkinson). Tasks in a day are not strictly independent, so this
 * understates correlated uncertainty — noted in the methodology as a known
 * limitation, and the reason day-level ranges are presented as approximate.
 */
export function sumDistributions(ds: readonly EffortDistribution[]): EffortDistribution {
  const live = ds.filter((d) => d.median > 0);
  if (live.length === 0) return lognormal(0, 0.5);
  let sumMean = 0;
  let sumVar = 0;
  for (const d of live) {
    const m = d.mean;
    const v = (Math.exp(d.sigma * d.sigma) - 1) * m * m;
    sumMean += m;
    sumVar += v;
  }
  if (sumMean <= 0) return lognormal(0, 0.5);
  const sigmaSq = Math.log(1 + sumVar / (sumMean * sumMean));
  const sigma = Math.sqrt(Math.max(sigmaSq, 0.0025));
  const mu = Math.log(sumMean) - sigmaSq / 2;
  const median = Math.exp(mu);
  return {
    median,
    sigma,
    p10: Math.exp(mu + Z10 * sigma),
    p50: median,
    p90: Math.exp(mu + Z90 * sigma),
    mean: sumMean,
  };
}

// ---------------------------------------------------------------------------
// The estimator
// ---------------------------------------------------------------------------

export function estimateTask(input: EstimateInput): TaskEstimate {
  const prior = CATEGORY_PRIORS[input.category];
  const ev = input.evidence;
  const factors: EstimationFactor[] = [];
  const notes: string[] = [];

  let median = prior.medianHours;
  let sigma = prior.sigma;

  const apply = (
    key: string,
    label: string,
    multiplier: number,
    rationale: string,
    epistemics: EstimationFactor['epistemics'] = 'derived',
  ): void => {
    if (Math.abs(multiplier - 1) < 0.005) return;
    factors.push({ key, label, multiplier, rationale, epistemics });
    median *= multiplier;
  };

  // --- scope: how much of the system was involved -------------------------
  // Logarithmic in files and subsystems. Ten files is not ten times one file.
  const files = ev.filesChanged;
  const subsystems = Math.max(1, ev.subsystemsTouched);
  if (files > 0) {
    const scope = clamp(0.55 + 0.28 * Math.log2(1 + files), 0.55, 2.6);
    apply(
      'scope',
      'Scope of change',
      scope,
      `${files} file${files === 1 ? '' : 's'} changed across ${subsystems} subsystem${subsystems === 1 ? '' : 's'}. Scaled logarithmically — file count is a weak proxy for effort.`,
    );
    if (subsystems > 1) {
      const cross = clamp(1 + 0.12 * Math.log2(subsystems), 1, 1.45);
      apply(
        'cross-subsystem',
        'Cross-cutting change',
        cross,
        `Touched ${subsystems} distinct areas of the codebase, which requires holding more context at once.`,
      );
    }
  } else {
    apply(
      'no-files',
      'No code produced',
      0.75,
      'No files were changed, so this task produced understanding rather than implementation.',
    );
  }

  // --- research depth -----------------------------------------------------
  // A category prior alone would credit a one-turn question the same as a
  // twenty-file investigation. Depth of evidence separates them.
  if (NON_IMPLEMENTATION_CATEGORIES.has(input.category) && input.researchDepth) {
    const { multiplier, artifacts } = input.researchDepth;
    apply(
      'research-depth',
      'Depth of investigation',
      multiplier,
      `${Math.round(artifacts)} investigative action${Math.round(artifacts) === 1 ? '' : 's'} (files read, searches, commands). Shallow exploration is credited far below the category baseline.`,
    );
  }

  // --- volume: strongly sublinear, generated content already excluded ------
  const netLines = ev.linesAdded + 0.4 * ev.linesRemoved;
  if (netLines > 0) {
    const volume = clamp(0.6 + 0.16 * Math.log2(1 + netLines / 40), 0.6, 2.2);
    apply(
      'volume',
      'Code volume',
      volume,
      `${ev.linesAdded} lines added, ${ev.linesRemoved} removed (generated and vendored files excluded). Heavily sublinear: a 5,000-line change is not 100× the work of a 50-line change.`,
    );
  }
  if (ev.generatedLinesAdded > 200) {
    notes.push(
      `${ev.generatedLinesAdded} lines in generated, vendored, or lockfile paths were excluded from the estimate.`,
    );
  }

  // --- debugging depth ----------------------------------------------------
  // Real errors indicate real difficulty, but an agent looping on the same
  // failure is not evidence that the task was hard for a human.
  if (ev.errorsEncountered > 0) {
    const distinctish = Math.min(ev.errorsEncountered, Math.max(2, ev.distinctCommands));
    const depth = clamp(1 + 0.09 * Math.log2(1 + distinctish), 1, 1.55);
    apply(
      'debug-depth',
      'Debugging depth',
      depth,
      `${ev.errorsEncountered} error${ev.errorsEncountered === 1 ? '' : 's'} encountered and worked through. Capped so that agent retry loops do not read as task difficulty.`,
    );
    if (ev.errorsEncountered > 6 && ev.distinctCommands < 4) {
      notes.push(
        'Many errors but few distinct commands — this pattern usually means the agent looped, not that the task was unusually hard. The difficulty credit was capped.',
      );
    }
  }

  // --- verification burden ------------------------------------------------
  const verifyRuns = ev.testsRun + ev.buildsRun + ev.typecheckRuns + ev.lintRuns;
  if (verifyRuns > 0) {
    const burden = clamp(1 + 0.07 * Math.log2(1 + verifyRuns), 1, 1.3);
    apply(
      'verification-burden',
      'Verification work',
      burden,
      `${verifyRuns} test, build, lint, or type-check run${verifyRuns === 1 ? '' : 's'} — a conventional workflow would have paid this cost too.`,
    );
  }

  // --- repository context -------------------------------------------------
  if (input.repoFileCount !== undefined && input.repoFileCount > 0) {
    const maturity = clamp(0.88 + 0.045 * Math.log10(1 + input.repoFileCount), 0.88, 1.35);
    apply(
      'repo-maturity',
      'Repository size and maturity',
      maturity,
      `Repository contains roughly ${input.repoFileCount.toLocaleString()} files. Larger, older codebases impose more reading and more care per change.`,
    );
  }
  if (!input.repoIsGit) {
    apply(
      'no-vcs',
      'No version control',
      0.92,
      'Work happened outside a Git repository, so it is more likely to be scratch or throwaway work.',
    );
  }
  if (input.languageCount > 1) {
    apply(
      'polyglot',
      'Multiple languages',
      clamp(1 + 0.07 * (input.languageCount - 1), 1, 1.25),
      `Spanned ${input.languageCount} languages, which adds context-switching cost.`,
    );
  }

  // --- inherent risk ------------------------------------------------------
  if (input.touchesMigration) {
    apply(
      'migration-risk',
      'Migration risk',
      1.25,
      'Touched migration or schema files, where mistakes are expensive and hard to reverse.',
    );
  }
  if (input.touchesInfra) {
    apply(
      'infra-risk',
      'Infrastructure risk',
      1.15,
      'Touched deployment or infrastructure definitions, where the feedback loop is slow.',
    );
  }

  // --- ambiguity ----------------------------------------------------------
  if (ev.userInstructions > 2) {
    const ambiguity = clamp(1 + 0.05 * Math.log2(ev.userInstructions), 1, 1.28);
    apply(
      'ambiguity',
      'Requirement ambiguity',
      ambiguity,
      `${ev.userInstructions} rounds of instruction. Work that needed steering to pin down would also have needed thinking time in a conventional workflow.`,
    );
  }

  // --- reuse / boilerplate discount ---------------------------------------
  let reuseFactor = 1;
  const boilerplateSignal = computeBoilerplateFraction(ev, input.semantic);
  if (boilerplateSignal > 0.15) {
    reuseFactor = clamp(1 - 0.55 * boilerplateSignal, 0.45, 1);
    apply(
      'boilerplate',
      'Routine or boilerplate content',
      reuseFactor,
      `About ${Math.round(boilerplateSignal * 100)}% of the output looks like boilerplate a conventional engineer would have scaffolded, copied, or generated deterministically. Discounted.`,
      input.semantic ? 'inferred' : 'derived',
    );
  }

  // --- semantic layer -----------------------------------------------------
  if (input.semantic) {
    const m = clamp(input.semantic.complexityMultiplier, 0.6, 1.6);
    apply('semantic', 'Task-understanding adjustment', m, input.semantic.rationale, 'inferred');
    notes.push(
      `A language model (${input.semantic.model}) reviewed a redacted summary of this task and adjusted the estimate by ${((m - 1) * 100).toFixed(0)}%. Its influence is clamped to ±60% and it never sets the estimate on its own.`,
    );
  }

  // --- personal calibration ------------------------------------------------
  let calibrated = false;
  if (input.calibration && input.calibration.sampleSize > 0) {
    const trust =
      Math.min(1, input.calibration.sampleSize / 5) * (input.calibration.categoryMatched ? 1 : 0.5);
    const m = 1 + (input.calibration.multiplier - 1) * trust;
    apply(
      'calibration',
      'Your calibration',
      clamp(m, 0.4, 2.5),
      `Based on ${input.calibration.sampleSize} task${input.calibration.sampleSize === 1 ? '' : 's'} you told us the real duration for${input.calibration.categoryMatched ? ' in this category' : ' in other categories'}. This adjusts your personalised view only.`,
      'user-corrected',
    );
    calibrated = true;
  }

  // --- sigma adjustments ---------------------------------------------------
  // Thin evidence widens the distribution; strong verification narrows it.
  if (files === 0 && ev.toolCalls < 5) {
    sigma *= 1.25;
    notes.push('Very little structural evidence, so the range is deliberately wide.');
  }
  if (input.verification.status === 'completed-validated') sigma *= 0.88;
  if (input.categoryConfidence < 0.5) {
    sigma *= 1.15;
    notes.push('The task category could not be determined confidently, which widens the range.');
  }
  if (input.verification.attributionAmbiguous) {
    sigma *= 1.1;
    notes.push(
      'Several sources changed these files, so attribution — and therefore the estimate — is less certain.',
    );
  }
  sigma = clamp(sigma, 0.45, 1.3);

  // --- mode ----------------------------------------------------------------
  const modeM = MODE_MULTIPLIER[input.mode];
  if (modeM !== 1) {
    factors.push({
      key: 'mode',
      label: `${input.mode} mode`,
      multiplier: modeM,
      rationale:
        input.mode === 'conservative'
          ? 'Conservative mode applies a 20% discount to every estimate. It is the default and the only mode used on share cards.'
          : input.mode === 'upper-range'
            ? 'Upper-range mode reports the higher end of a defensible interval.'
            : 'Balanced mode applies the priors as calibrated.',
      epistemics: 'derived',
    });
    median *= modeM;
  }

  // --- anti-gaming guard ---------------------------------------------------
  const evidenceStrength = computeEvidenceStrength(input);
  let guardEngaged = false;
  if (median > 12 && evidenceStrength < 0.5) {
    guardEngaged = true;
    const capped = 12 + (median - 12) * 0.35;
    factors.push({
      key: 'extreme-guard',
      label: 'Large estimate, thin evidence',
      multiplier: capped / median,
      rationale:
        'Estimates above 12 hours require strong evidence — passing tests, commits, or persistent files. This one does not have it, so the excess is heavily discounted.',
      epistemics: 'derived',
    });
    median = capped;
    notes.push('This task was flagged as a large estimate with weak supporting evidence.');
  }

  // --- assemble -------------------------------------------------------------
  const gross = lognormal(Math.max(0.05, median), sigma);
  const completionFactor = input.verification.completionFactor;
  const verificationFactor = input.verification.verificationFactor;
  const accepted = scaleDistribution(gross, completionFactor);
  const verified = scaleDistribution(accepted, verificationFactor);

  if (completionFactor < 1) {
    notes.push(
      `Only ${Math.round(completionFactor * 100)}% of the intended outcome was produced (status: ${input.verification.status}), so accepted hours are scaled down accordingly.`,
    );
  }
  if (verificationFactor < 1) {
    notes.push(
      `Validation was ${Math.round(verificationFactor * 100)}% of the strongest available standard, so verified hours are further reduced.`,
    );
  }

  const { level, score } = computeConfidence(input, evidenceStrength, sigma, guardEngaged);

  const userOverride = input.userOverrideHours;
  if (userOverride !== undefined && userOverride >= 0) {
    const overrideDist = lognormal(userOverride, 0.35);
    return {
      taskId: input.taskId,
      benchmarkVersion: BENCHMARK_VERSION,
      mode: input.mode,
      gross: overrideDist,
      accepted: overrideDist,
      verified: overrideDist,
      completionFactor: 1,
      verificationFactor: 1,
      reuseFactor,
      factors: [
        {
          key: 'user-override',
          label: 'You set this estimate',
          multiplier: 1,
          rationale: `You said this task would have taken ${userOverride} hours conventionally. Your value replaces the model entirely and is labelled as edited wherever it appears.`,
          epistemics: 'user-corrected',
        },
      ],
      confidence: 'high',
      confidenceScore: 1,
      uncertaintyNotes: ['This estimate was set by you, not computed.'],
      priorId: prior.anchor,
      calibrated: true,
      userOverrideHours: userOverride,
      semanticUsed: false,
      computedAt: Date.now(),
    };
  }

  return {
    taskId: input.taskId,
    benchmarkVersion: BENCHMARK_VERSION,
    mode: input.mode,
    gross,
    accepted,
    verified,
    completionFactor,
    verificationFactor,
    reuseFactor,
    factors,
    confidence: level,
    confidenceScore: score,
    uncertaintyNotes: notes,
    priorId: prior.anchor,
    calibrated,
    semanticUsed: Boolean(input.semantic),
    computedAt: Date.now(),
  };
}

/**
 * Fraction of output that looks like boilerplate.
 *
 * Config-heavy changes, very large single-file additions, and low
 * subsystem-to-file ratios all indicate scaffolding rather than reasoning.
 */
function computeBoilerplateFraction(ev: TaskEvidence, semantic?: SemanticAdjustment): number {
  if (semantic) return clamp(semantic.boilerplateFraction, 0, 0.85);
  if (ev.filesChanged === 0) return 0;
  let score = 0;
  const avgLinesPerFile = ev.linesAdded / Math.max(1, ev.filesChanged);
  // Huge uniform additions across many files: scaffolding shape.
  if (avgLinesPerFile > 250 && ev.filesChanged > 4) score += 0.3;
  // Almost no deletions and almost no verification: nothing was integrated.
  if (ev.linesRemoved < ev.linesAdded * 0.03 && ev.testsRun === 0 && ev.linesAdded > 400)
    score += 0.25;
  // Many files, one subsystem: repetitive structure.
  if (ev.filesChanged >= 6 && ev.subsystemsTouched <= 1) score += 0.15;
  // No errors at all on a large change: no integration friction was hit.
  if (ev.errorsEncountered === 0 && ev.linesAdded > 800) score += 0.15;
  return clamp(score, 0, 0.7);
}

/** How much hard evidence supports this task, in [0, 1]. */
function computeEvidenceStrength(input: EstimateInput): number {
  const ev = input.evidence;
  const v = input.verification;
  let s = 0;
  if (ev.filesChanged > 0) s += 0.2;
  if (v.filesStillPresent > 0) s += 0.2;
  if (ev.testsPassed > 0) s += 0.2;
  if (ev.buildsPassed > 0 || ev.typecheckRuns > 0) s += 0.1;
  if (ev.commits > 0) s += 0.15;
  if (input.repoIsGit) s += 0.05;
  if (input.categoryConfidence > 0.6) s += 0.1;
  if (v.attributionAmbiguous) s -= 0.1;
  return clamp(s, 0, 1);
}

function computeConfidence(
  input: EstimateInput,
  evidenceStrength: number,
  sigma: number,
  guardEngaged = false,
): { level: ConfidenceLevel; score: number } {
  // Confidence blends evidence strength, category certainty, and distribution
  // width. A wide distribution is honest, but it is still low confidence.
  const widthPenalty = clamp((sigma - 0.45) / 0.85, 0, 1);
  let score = 0.55 * evidenceStrength + 0.25 * input.categoryConfidence + 0.2 * (1 - widthPenalty);
  if (input.calibration && input.calibration.sampleSize >= 3) score += 0.08;
  if (input.verification.status === 'unknown') score -= 0.1;
  // If the estimate had to be capped for lack of evidence, we are by definition
  // not confident in it.
  if (guardEngaged) score *= 0.65;
  score = clamp(score, 0, 1);
  const level: ConfidenceLevel = score >= 0.68 ? 'high' : score >= 0.42 ? 'medium' : 'low';
  return { level, score };
}
