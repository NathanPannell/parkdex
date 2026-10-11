/**
 * Photo lab decision and scoring logic. It runs in Node (tests, the runner) and in the dashboard,
 * which loads it and worker/founderPhoto.ts as browser modules, so every decision the dashboard
 * shows comes from the production decidePhoto. Keep this file free of Node imports.
 */
import {
  decidePhoto, DEFAULT_FLAG_THRESHOLDS, DEFAULT_PHOTO_APPROVE_THRESHOLD, FLAG_THRESHOLD, PHOTO_FLAGS,
  type PhotoAnswers, type PhotoFlag,
} from "../../worker/founderPhoto.ts";

export const CATEGORIES = ["good", "people", "blurry", "dark", "not_park", "not_photo", "personal_info", "borderline"] as const;
export type Category = (typeof CATEGORIES)[number];
export type ExpectedOutcome = "approve" | "reject" | "either";
export type Outcome = "approve" | "reject" | "unsure";

export interface ManifestPhoto {
  id: string;
  category: Category;
  description: string;
  expected: { outcome: ExpectedOutcome; flags: PhotoFlag[]; optionalFlags: PhotoFlag[] };
  source: Record<string, unknown> & { type: "commons" | "derived" };
}

export interface Manifest {
  version: 1;
  notes: string;
  notCovered: PhotoFlag[];
  photos: ManifestPhoto[];
}

export interface RunPhotoResult {
  answers: PhotoAnswers["answers"] | null;
  model: string | null;
  error: string | null;
  latencyMs: number;
  attempts: number;
  costUsd: number | null;
  /** The run this result was queried in; differs from the run's id when it was carried over. */
  queriedIn: string;
}

export interface RunFile {
  version: 1;
  id: string;
  label: string;
  createdAt: string;
  finishedAt: string;
  model: string;
  context: { parkName: string; parkKind: string };
  /** SHA-256 of the questions sent, so runs with different wording are not compared blindly. */
  questionsSha256: string;
  basedOn: string | null;
  queried: string[];
  results: Record<string, RunPhotoResult>;
  spend: { reportedCostUsd: number; keyUsageBeforeUsd: number | null; keyUsageAfterUsd: number | null };
}

/**
 * How a photo with no flag that is not approved is decided. Production calls all of them unsure;
 * `reject_verdict` turns a confident "reject" verdict into a rejection without a named flag.
 */
export type UnsureMode = "production" | "reject_verdict";

export interface LabSettings {
  approve: number;
  flags: Record<PhotoFlag, number>;
  unsureMode: UnsureMode;
  /** Used by `reject_verdict`: the verdict's reject probability at or above which it rejects. */
  rejectVerdict: number;
}

export function productionSettings(): LabSettings {
  return { approve: DEFAULT_PHOTO_APPROVE_THRESHOLD, flags: { ...DEFAULT_FLAG_THRESHOLDS }, unsureMode: "production", rejectVerdict: 0.5 };
}

export interface LabDecision {
  outcome: Outcome;
  flags: PhotoFlag[];
}

export function decideLab(answers: PhotoAnswers["answers"], settings: LabSettings): LabDecision {
  const decision = decidePhoto({ model: "", answers }, settings.approve, settings.flags);
  if (decision.outcome === "unsure" && settings.unsureMode === "reject_verdict") {
    const reject = answers.verdict?.probabilities.reject;
    if (typeof reject === "number" && reject >= settings.rejectVerdict) return { outcome: "reject", flags: [] };
  }
  return { outcome: decision.outcome, flags: [...decision.flags] };
}

export function yesProbability(answers: PhotoAnswers["answers"], flag: PhotoFlag): number {
  const answer = answers[flag];
  if (!answer) return 0;
  const value = answer.probabilities.yes;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return answer.choice === "yes" ? 1 : 0;
}

/** agree: the outcome matches. safe: a bad photo was not approved but was called unsure. */
export type Agreement = "agree" | "disagree" | "safe" | "error";

export interface PhotoEvaluation {
  id: string;
  decision: LabDecision | null;
  agreement: Agreement;
  falseApproval: boolean;
  falseRejection: boolean;
  /** For a rejected bad photo: whether at least one expected flag was raised. */
  rightReason: boolean | null;
}

export interface FlagScore {
  flag: PhotoFlag;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number | null;
  recall: number | null;
  covered: boolean;
}

export interface Summary {
  scored: number;
  correct: number;
  accuracy: number | null;
  errors: number;
  /** Rows are the expected outcome, columns the decision. */
  confusion: Record<ExpectedOutcome, Record<Outcome, number>>;
  falseApprovals: string[];
  falseRejections: string[];
  badBlocked: number;
  badTotal: number;
  goodApproved: number;
  goodTotal: number;
  rightReason: number;
  rejectedBad: number;
  flags: FlagScore[];
}

export function evaluatePhoto(photo: ManifestPhoto, result: RunPhotoResult | undefined, settings: LabSettings): PhotoEvaluation {
  if (!result?.answers) return { id: photo.id, decision: null, agreement: "error", falseApproval: false, falseRejection: false, rightReason: null };
  const decision = decideLab(result.answers, settings);
  const expected = photo.expected.outcome;
  let agreement: Agreement = "agree";
  if (expected === "approve" && decision.outcome !== "approve") agreement = "disagree";
  if (expected === "reject" && decision.outcome === "approve") agreement = "disagree";
  if (expected === "reject" && decision.outcome === "unsure") agreement = "safe";
  const rightReason = expected === "reject" && decision.outcome === "reject"
    ? decision.flags.some((flag) => photo.expected.flags.includes(flag))
    : null;
  return {
    id: photo.id,
    decision,
    agreement,
    falseApproval: expected === "reject" && decision.outcome === "approve",
    falseRejection: expected === "approve" && decision.outcome !== "approve",
    rightReason,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function summarize(manifest: Manifest, run: Pick<RunFile, "results">, settings: LabSettings): { photos: PhotoEvaluation[]; summary: Summary } {
  const photos = manifest.photos.map((photo) => evaluatePhoto(photo, run.results[photo.id], settings));
  const confusion = Object.fromEntries((["approve", "reject", "either"] as const).map((row) => [row, { approve: 0, reject: 0, unsure: 0 }])) as Summary["confusion"];
  const scores = new Map<PhotoFlag, FlagScore>(PHOTO_FLAGS.map((flag) => [flag, {
    flag, truePositive: 0, falsePositive: 0, falseNegative: 0, trueNegative: 0, precision: null, recall: null,
    covered: !manifest.notCovered.includes(flag),
  }]));
  const summary: Summary = {
    scored: 0, correct: 0, accuracy: null, errors: 0, confusion, falseApprovals: [], falseRejections: [],
    badBlocked: 0, badTotal: 0, goodApproved: 0, goodTotal: 0, rightReason: 0, rejectedBad: 0, flags: [],
  };
  manifest.photos.forEach((photo, index) => {
    const evaluation = photos[index];
    const answers = run.results[photo.id]?.answers;
    if (!evaluation.decision || !answers) {
      summary.errors += 1;
      return;
    }
    const expected = photo.expected.outcome;
    confusion[expected][evaluation.decision.outcome] += 1;
    if (expected !== "either") {
      summary.scored += 1;
      if (evaluation.agreement === "agree") summary.correct += 1;
    }
    if (expected === "reject") {
      summary.badTotal += 1;
      if (evaluation.decision.outcome !== "approve") summary.badBlocked += 1;
      if (evaluation.decision.outcome === "reject") summary.rejectedBad += 1;
      if (evaluation.rightReason) summary.rightReason += 1;
    }
    if (expected === "approve") {
      summary.goodTotal += 1;
      if (evaluation.decision.outcome === "approve") summary.goodApproved += 1;
    }
    if (evaluation.falseApproval) summary.falseApprovals.push(photo.id);
    if (evaluation.falseRejection) summary.falseRejections.push(photo.id);
    for (const flag of PHOTO_FLAGS) {
      // Bad photos are labelled with their main defect only, so their other flags are unknown.
      // Optional flags are allowed either way. Neither is scored.
      if (photo.expected.optionalFlags.includes(flag)) continue;
      if (expected === "reject" && !photo.expected.flags.includes(flag)) continue;
      const score = scores.get(flag)!;
      const predicted = yesProbability(answers, flag) > (settings.flags[flag] ?? FLAG_THRESHOLD);
      const actual = photo.expected.flags.includes(flag);
      if (predicted && actual) score.truePositive += 1;
      else if (predicted) score.falsePositive += 1;
      else if (actual) score.falseNegative += 1;
      else score.trueNegative += 1;
    }
  });
  summary.accuracy = ratio(summary.correct, summary.scored);
  summary.flags = [...scores.values()].map((score) => ({
    ...score,
    precision: ratio(score.truePositive, score.truePositive + score.falsePositive),
    recall: ratio(score.truePositive, score.truePositive + score.falseNegative),
  }));
  return { photos, summary };
}

function number(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** The thresholds as JSON for sharing, and the change to make in worker/founderPhoto.ts. */
export function exportSettings(settings: LabSettings): { json: string; code: string } {
  const json = JSON.stringify({
    approve: settings.approve,
    flags: Object.fromEntries(PHOTO_FLAGS.map((flag) => [flag, settings.flags[flag]])),
    unsureMode: settings.unsureMode,
    ...(settings.unsureMode === "reject_verdict" ? { rejectVerdict: settings.rejectVerdict } : {}),
  }, null, 2);
  const lines = [
    "// worker/founderPhoto.ts",
    `export const DEFAULT_PHOTO_APPROVE_THRESHOLD = ${number(settings.approve)};`,
    "",
    "export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = Object.freeze({",
    ...PHOTO_FLAGS.map((flag) => {
      const value = settings.flags[flag];
      return `  ${flag}: ${value === FLAG_THRESHOLD ? "FLAG_THRESHOLD" : number(value)},`;
    }),
    "});",
  ];
  if (settings.approve < 0.5 || settings.approve > 1) {
    lines.push("", "// photoApproveThreshold() only accepts 0.5 to 1; widen its bounds for this value.");
  }
  lines.push("", `// FOUNDER_PHOTO_APPROVE_THRESHOLD, when set in the environment, overrides the approve default.`);
  if (settings.unsureMode === "reject_verdict") {
    lines.push(
      "",
      "// decidePhoto: a confident reject verdict with no flag becomes a rejection instead of unsure.",
      "// Replace the final `return { outcome: \"unsure\", flags: [] };` with:",
      `if ((verdict?.probabilities.reject ?? 0) >= ${number(settings.rejectVerdict)}) return { outcome: "reject", flags: [] };`,
      "return { outcome: \"unsure\", flags: [] };",
      "// The reject type then allows an empty flags list; founders.ts shows UNSURE_MESSAGE or a general message for it.",
    );
  }
  return { json, code: lines.join("\n") };
}
