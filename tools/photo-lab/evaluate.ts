/**
 * Photo lab decision and scoring logic. It runs in Node (tests, the runner) and in the dashboard,
 * which loads it and worker/founderPhoto.ts as browser modules, so every decision the dashboard
 * shows comes from the production decidePhoto. Keep this file free of Node imports.
 */
import { decidePhoto, DEFAULT_FLAG_THRESHOLDS, PHOTO_FLAGS, type PhotoAnswers, type PhotoFlag } from "../../worker/founderPhoto.ts";

export const CATEGORIES = ["good", "people", "blurry", "dark", "not_park", "not_photo", "personal_info", "borderline"] as const;
export type Category = (typeof CATEGORIES)[number];
export type ExpectedOutcome = "approve" | "reject" | "either";
export type Outcome = "approve" | "reject";

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
  /** Runs made before the verdict question was dropped also have a `verdict` answer, which is ignored. */
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

/** A photo is approved when no flag's "yes" is above that flag's threshold, as in production. */
export interface LabSettings {
  flags: Record<PhotoFlag, number>;
}

export function productionSettings(): LabSettings {
  return { flags: { ...DEFAULT_FLAG_THRESHOLDS } };
}

export interface LabDecision {
  outcome: Outcome;
  flags: PhotoFlag[];
}

export function decideLab(answers: PhotoAnswers["answers"], settings: LabSettings): LabDecision {
  const decision = decidePhoto({ model: "", answers }, settings.flags);
  return { outcome: decision.outcome, flags: [...decision.flags] };
}

export function yesProbability(answers: PhotoAnswers["answers"], flag: PhotoFlag): number {
  const answer = answers[flag];
  if (!answer) return 0;
  const value = answer.probabilities.yes;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return answer.choice === "yes" ? 1 : 0;
}

/** agree: the outcome matches, or the photo is borderline. */
export type Agreement = "agree" | "disagree" | "error";

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
  /** Bad photos rejected. */
  badBlocked: number;
  badTotal: number;
  goodApproved: number;
  goodTotal: number;
  /** Rejected bad photos with at least one expected flag. */
  rightReason: number;
  flags: FlagScore[];
}

export function evaluatePhoto(photo: ManifestPhoto, result: RunPhotoResult | undefined, settings: LabSettings): PhotoEvaluation {
  if (!result?.answers) return { id: photo.id, decision: null, agreement: "error", falseApproval: false, falseRejection: false, rightReason: null };
  const decision = decideLab(result.answers, settings);
  const expected = photo.expected.outcome;
  const agreement: Agreement = expected === "either" || expected === decision.outcome ? "agree" : "disagree";
  const rightReason = expected === "reject" && decision.outcome === "reject" ? decision.flags.some((flag) => photo.expected.flags.includes(flag)) : null;
  return {
    id: photo.id,
    decision,
    agreement,
    falseApproval: expected === "reject" && decision.outcome === "approve",
    falseRejection: expected === "approve" && decision.outcome === "reject",
    rightReason,
  };
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

export function summarize(manifest: Manifest, run: Pick<RunFile, "results">, settings: LabSettings): { photos: PhotoEvaluation[]; summary: Summary } {
  const photos = manifest.photos.map((photo) => evaluatePhoto(photo, run.results[photo.id], settings));
  const confusion = Object.fromEntries((["approve", "reject", "either"] as const).map((row) => [row, { approve: 0, reject: 0 }])) as Summary["confusion"];
  const scores = new Map<PhotoFlag, FlagScore>(
    PHOTO_FLAGS.map((flag) => [
      flag,
      {
        flag,
        truePositive: 0,
        falsePositive: 0,
        falseNegative: 0,
        trueNegative: 0,
        precision: null,
        recall: null,
        covered: !manifest.notCovered.includes(flag),
      },
    ]),
  );
  const summary: Summary = {
    scored: 0,
    correct: 0,
    accuracy: null,
    errors: 0,
    confusion,
    falseApprovals: [],
    falseRejections: [],
    badBlocked: 0,
    badTotal: 0,
    goodApproved: 0,
    goodTotal: 0,
    rightReason: 0,
    flags: [],
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
      if (evaluation.decision.outcome === "reject") summary.badBlocked += 1;
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
      const predicted = yesProbability(answers, flag) > (settings.flags[flag] ?? DEFAULT_FLAG_THRESHOLDS[flag]);
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

/** The flag thresholds as JSON for sharing, and the constant to paste into worker/founderPhoto.ts. */
export function exportSettings(settings: LabSettings): { json: string; code: string } {
  const flags = Object.fromEntries(PHOTO_FLAGS.map((flag) => [flag, Number(number(settings.flags[flag]))]));
  const json = JSON.stringify({ flags }, null, 2);
  const code = [
    "// worker/founderPhoto.ts",
    "export const DEFAULT_FLAG_THRESHOLDS: FlagThresholds = Object.freeze({",
    ...PHOTO_FLAGS.map((flag) => `  ${flag}: ${number(settings.flags[flag])},`),
    "});",
  ].join("\n");
  return { json, code };
}
