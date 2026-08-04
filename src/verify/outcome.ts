import fs from 'node:fs';

import type { NormalizedEvent, TaskEvidence, TaskStatus } from '../core/types.ts';
import type { GitCommit } from '../git/git.ts';

/**
 * Outcome verification.
 *
 * The product measures *retained, validated* outcomes. A task that generated
 * 5,000 lines and left the tree broken must not out-score a 20-line fix that
 * passed the suite. This module decides, from evidence only, what actually
 * happened — and how strongly we can claim it.
 *
 * Agent self-reports ("Done! Everything works.") are treated as weak evidence
 * and can never on their own produce a `completed-validated` status.
 */

export interface VerificationInput {
  readonly events: readonly NormalizedEvent[];
  readonly evidence: TaskEvidence;
  /** Non-generated paths the task claims to have changed. */
  readonly paths: readonly string[];
  readonly repoRoot?: string;
  readonly repoIsGit: boolean;
  /** Commits in the repository overlapping or following the task window. */
  readonly commits?: readonly GitCommit[];
  readonly taskStart: number;
  readonly taskEnd: number;
  /** Skip filesystem checks (used by tests and by fixture evaluation). */
  readonly skipFsChecks?: boolean;
}

export interface VerificationResult {
  readonly status: TaskStatus;
  /**
   * How much of the intended outcome was produced, in [0, 1]. Multiplies the
   * gross estimate to give *accepted* work.
   */
  readonly completionFactor: number;
  /**
   * How well the produced outcome was validated, in [0, 1]. Multiplies the
   * accepted estimate to give *verified* work — the headline figure.
   */
  readonly verificationFactor: number;
  readonly filesStillPresent: number;
  readonly filesMissing: number;
  readonly signals: VerificationSignal[];
  /** Ambiguous attribution: human edits or other agents touched the same files. */
  readonly attributionAmbiguous: boolean;
}

export interface VerificationSignal {
  readonly key: string;
  readonly label: string;
  readonly polarity: 'positive' | 'negative' | 'neutral';
  readonly detail: string;
}

/** Completion credit by status. Encodes the anti-gaming policy in one place. */
export const STATUS_COMPLETION: Record<TaskStatus, number> = {
  'completed-validated': 1.0,
  'completed-weak-validation': 1.0,
  partial: 0.5,
  exploratory: 1.0, // research produces its full intended outcome: understanding
  failed: 0.15,
  abandoned: 0.1,
  reverted: 0.0,
  superseded: 0.0,
  unknown: 0.5,
};

/** Verification credit by status. This is the conservatism dial. */
export const STATUS_VERIFICATION: Record<TaskStatus, number> = {
  'completed-validated': 1.0,
  'completed-weak-validation': 0.7,
  partial: 0.55,
  exploratory: 0.6,
  failed: 0.3,
  abandoned: 0.25,
  reverted: 0.0,
  superseded: 0.0,
  unknown: 0.45,
};

const ACCEPTANCE_RE =
  /\b(?:looks good|lgtm|perfect|nice work|that works|works now|ship it|great,? thanks|thanks[,!.]?$|exactly|correct|yes that'?s it)\b/i;
const REJECTION_RE =
  /\b(?:that'?s wrong|doesn'?t work|still (?:broken|failing|wrong)|revert|undo (?:that|this)|start over|no,? that'?s not|broke)\b/i;

export function verifyOutcome(input: VerificationInput): VerificationResult {
  const signals: VerificationSignal[] = [];
  const ev = input.evidence;
  const sorted = [...input.events].sort((a, b) => a.ts - b.ts);

  // ---- 1. does the work still exist on disk? -----------------------------
  // If the project directory itself is gone (moved, deleted, or synthetic),
  // absence of files proves nothing about the outcome. Concluding "failed"
  // from an unreachable tree would be a false negative, so we skip the check
  // entirely and let the other signals decide.
  const repoReachable =
    input.repoRoot === undefined ||
    (() => {
      try {
        return fs.existsSync(input.repoRoot as string);
      } catch {
        return false;
      }
    })();

  let filesStillPresent = 0;
  let filesMissing = 0;
  if (!input.skipFsChecks && repoReachable && input.paths.length > 0) {
    for (const p of input.paths) {
      try {
        if (fs.existsSync(p)) filesStillPresent++;
        else filesMissing++;
      } catch {
        filesMissing++;
      }
    }
    if (filesMissing > 0 && filesStillPresent === 0) {
      signals.push({
        key: 'files-gone',
        label: 'No changed file survives',
        polarity: 'negative',
        detail: `${filesMissing} of ${input.paths.length} changed files are no longer on disk.`,
      });
    } else if (filesStillPresent > 0) {
      signals.push({
        key: 'files-present',
        label: 'Changes persist on disk',
        polarity: 'positive',
        detail: `${filesStillPresent} of ${input.paths.length} changed files still exist.`,
      });
    }
  } else {
    // Persistence unknown; treat as neutral rather than positive or negative.
    filesStillPresent = input.paths.length;
    if (!repoReachable && input.paths.length > 0) {
      signals.push({
        key: 'tree-unreachable',
        label: 'Project directory is no longer reachable',
        polarity: 'neutral',
        detail: 'File persistence could not be checked, so it did not influence the outcome.',
      });
    }
  }

  // ---- 2. verification commands, in chronological order -------------------
  const lastChangeTs = lastTsOfKinds(sorted, ['file.created', 'file.modified', 'file.deleted']);
  const verifyEvents = sorted.filter(
    (e) =>
      (e.kind === 'test.run' ||
        e.kind === 'build.run' ||
        e.kind === 'typecheck.run' ||
        e.kind === 'lint.run') &&
      e.payload.outcome !== undefined,
  );
  const afterChange =
    lastChangeTs === undefined ? verifyEvents : verifyEvents.filter((e) => e.ts >= lastChangeTs);
  const finalVerify = afterChange.length > 0 ? afterChange : verifyEvents;

  const finalPassing = finalVerify.filter((e) => e.payload.outcome === 'pass');
  const finalFailing = finalVerify.filter((e) => e.payload.outcome === 'fail');
  const hasTestPassAfterChange = afterChange.some(
    (e) => e.kind === 'test.run' && e.payload.outcome === 'pass',
  );
  const hasFailureAfterChange = afterChange.some((e) => e.payload.outcome === 'fail');

  if (hasTestPassAfterChange) {
    signals.push({
      key: 'tests-pass',
      label: 'Tests passed after the final change',
      polarity: 'positive',
      detail: `${ev.testsPassed} passing test run(s) recorded, at least one after the last edit.`,
    });
  }
  if (hasFailureAfterChange) {
    signals.push({
      key: 'verify-fail',
      label: 'A verification command failed after the final change',
      polarity: 'negative',
      detail: `${finalFailing.length} failing run(s) with no successful re-run afterwards.`,
    });
  }
  if (!hasTestPassAfterChange && finalPassing.length > 0) {
    signals.push({
      key: 'build-pass',
      label: 'Build or type check passed',
      polarity: 'positive',
      detail: `${finalPassing.length} passing build/lint/typecheck run(s).`,
    });
  }
  if (finalVerify.length === 0 && ev.filesChanged > 0) {
    signals.push({
      key: 'no-verification',
      label: 'No tests, build, or type check ran',
      polarity: 'negative',
      detail: 'The change was never executed or checked in this session.',
    });
  }

  // ---- 3. git evidence ----------------------------------------------------
  let commitsTouching = 0;
  let revertsTouching = 0;
  if (input.commits && input.repoRoot) {
    const wanted = new Set(input.paths.map((p) => relativeTo(p, input.repoRoot as string)));
    for (const c of input.commits) {
      const hits = c.paths.some((p) => wanted.has(p));
      if (!hits) continue;
      if (c.ts >= input.taskStart - 5 * 60_000) {
        if (c.isRevert) revertsTouching++;
        else commitsTouching++;
      }
    }
    if (commitsTouching > 0) {
      signals.push({
        key: 'committed',
        label: 'Work was committed',
        polarity: 'positive',
        detail: `${commitsTouching} commit(s) touching these files after the task began.`,
      });
    }
    if (revertsTouching > 0) {
      signals.push({
        key: 'reverted',
        label: 'Work was later reverted',
        polarity: 'negative',
        detail: `${revertsTouching} revert commit(s) touch these files.`,
      });
    }
  }

  // ---- 4. conversational acceptance --------------------------------------
  const laterInstructions = sorted.filter((e) => e.kind === 'user.instruction' && e.payload.text);
  const lastInstruction = laterInstructions[laterInstructions.length - 1];
  let userAccepted = false;
  let userRejected = false;
  for (const e of laterInstructions) {
    const t = e.payload.text as string;
    if (ACCEPTANCE_RE.test(t)) userAccepted = true;
    if (REJECTION_RE.test(t)) userRejected = true;
  }
  if (userAccepted) {
    signals.push({
      key: 'user-accepted',
      label: 'You signalled acceptance',
      polarity: 'positive',
      detail: 'A later message indicated the result was correct.',
    });
  }
  if (userRejected) {
    signals.push({
      key: 'user-rejected',
      label: 'You reported the result was wrong',
      polarity: 'negative',
      detail: 'A later message indicated the result was broken or needed reverting.',
    });
  }

  // ---- 5. interruption / abandonment -------------------------------------
  const endedOnInterrupt =
    lastInstruction === undefined &&
    sorted.length > 0 &&
    (sorted[sorted.length - 1] as NormalizedEvent).kind === 'user.interrupt';
  const unresolvedErrors =
    ev.errorsEncountered > 0 && !hasTestPassAfterChange && hasFailureAfterChange;

  // ---- 6. attribution ambiguity ------------------------------------------
  const humanEdited = sorted.some(
    (e) => e.payload.reason === 'human-edit' || e.payload.reason === 'user-modified',
  );
  const multiSession = new Set(sorted.map((e) => e.sessionId)).size > 1;
  const attributionAmbiguous =
    humanEdited ||
    (multiSession && input.repoIsGit && commitsTouching === 0 && input.paths.length > 3);
  if (humanEdited) {
    signals.push({
      key: 'human-edit',
      label: 'You edited these files directly',
      polarity: 'neutral',
      detail: 'Part of this change was made by hand, so attribution is shared.',
    });
  }

  // ---- 6b. self-revert: created then deleted inside the same task ---------
  // A task can be undone without any Git commit at all — the agent simply
  // deletes what it just wrote, usually right after the user says "revert
  // that". Detect it structurally rather than trusting the conversation alone.
  const created = new Set<string>();
  const deleted = new Set<string>();
  for (const e of sorted) {
    for (const f of e.payload.files ?? []) {
      if (f.changeType === 'add') created.add(f.path);
      if (f.changeType === 'delete') deleted.add(f.path);
    }
  }
  let selfReverted = 0;
  for (const p of created) if (deleted.has(p)) selfReverted++;
  const selfRevert =
    selfReverted > 0 && (userRejected || selfReverted >= Math.max(1, created.size));
  if (selfRevert) {
    signals.push({
      key: 'self-revert',
      label: 'Work was undone within the task',
      polarity: 'negative',
      detail: `${selfReverted} file(s) created and then deleted again before the task ended.`,
    });
  }

  // ---- 7. decide status ---------------------------------------------------
  const changedSomething = ev.filesChanged > 0;
  let status: TaskStatus;

  if (
    revertsTouching > 0 ||
    selfRevert ||
    (userRejected && filesStillPresent === 0 && changedSomething)
  ) {
    status = 'reverted';
  } else if (!changedSomething) {
    // Nothing was written. Research if it looks like reading; abandoned if the
    // user clearly asked for a change and nothing happened.
    if (ev.researchArtifacts >= 3 || ev.toolCalls >= 3) status = 'exploratory';
    else if (ev.userInstructions > 0 && ev.humanInterrupts > 0) status = 'abandoned';
    else status = 'exploratory';
  } else if (filesMissing > 0 && filesStillPresent === 0) {
    status = 'failed';
  } else if (hasFailureAfterChange && !hasTestPassAfterChange) {
    status = unresolvedErrors && ev.humanInterrupts > 0 ? 'abandoned' : 'partial';
  } else if (endedOnInterrupt) {
    status = 'partial';
  } else if (hasTestPassAfterChange || (commitsTouching > 0 && finalPassing.length > 0)) {
    status = 'completed-validated';
  } else if (finalPassing.length > 0 || commitsTouching > 0 || userAccepted) {
    status = 'completed-weak-validation';
  } else if (filesStillPresent > 0) {
    status = 'completed-weak-validation';
  } else {
    status = 'unknown';
  }

  // ---- 8. graded factors ---------------------------------------------------
  let completion = STATUS_COMPLETION[status];
  let verification = STATUS_VERIFICATION[status];

  // Partial persistence scales completion continuously rather than in steps.
  if (input.paths.length > 0 && filesStillPresent > 0 && filesMissing > 0) {
    const survived = filesStillPresent / (filesStillPresent + filesMissing);
    completion *= 0.4 + 0.6 * survived;
    signals.push({
      key: 'partial-survival',
      label: 'Some changes did not survive',
      polarity: 'negative',
      detail: `${Math.round(survived * 100)}% of changed files still exist.`,
    });
  }

  // Strong multi-signal validation earns a small premium, capped at 1.
  if (status === 'completed-validated') {
    const strong = [
      hasTestPassAfterChange,
      commitsTouching > 0,
      ev.typecheckRuns > 0,
      ev.lintRuns > 0,
    ].filter(Boolean).length;
    verification = Math.min(1, 0.85 + 0.05 * strong);
  }

  // Ambiguous attribution reduces how much we are willing to claim.
  if (attributionAmbiguous) {
    verification *= 0.85;
    signals.push({
      key: 'attribution',
      label: 'Attribution is ambiguous',
      polarity: 'neutral',
      detail: 'Several sources changed these files; credit is shared and discounted.',
    });
  }

  // Heavy rework inside the task itself is discounted: retries are not output.
  if (ev.retries > 2 || ev.humanInterrupts > 3) {
    completion *= 0.9;
    signals.push({
      key: 'rework',
      label: 'Substantial rework during the task',
      polarity: 'negative',
      detail: `${ev.retries} retries and ${ev.humanInterrupts} interruptions.`,
    });
  }

  return {
    status,
    completionFactor: clamp01(completion),
    verificationFactor: clamp01(verification),
    filesStillPresent,
    filesMissing,
    signals,
    attributionAmbiguous,
  };
}

function lastTsOfKinds(
  events: readonly NormalizedEvent[],
  kinds: readonly string[],
): number | undefined {
  let out: number | undefined;
  for (const e of events) if (kinds.includes(e.kind)) out = e.ts;
  return out;
}

function relativeTo(p: string, root: string): string {
  const norm = p.replace(/\\/g, '/');
  const r = root.replace(/\\/g, '/').replace(/\/$/, '');
  return norm.startsWith(`${r}/`) ? norm.slice(r.length + 1) : norm;
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
