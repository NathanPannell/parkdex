import { moderate, type ModerationAnswer, type ModerationEnv, type ModerationFetch, type ModerationQuestion } from "./moderation.js";

/**
 * The founder photo check: one Decisions API call with an overall verdict and six yes/no flags,
 * each with a message the player sees. The wording was tuned with live probes (#126): a night
 * photo needs "too dark to see the place clearly, at night or in deep shade" to be flagged, and
 * "judge only the light" stops walls and screenshots from also being flagged as too dark.
 */

export const DEFAULT_PHOTO_APPROVE_THRESHOLD = 0.8;
/** A flag counts when its "yes" is above this. */
export const FLAG_THRESHOLD = 0.5;
/** Photos are larger than the text checks; a 1,280 px JPEG answered in under a second in probes. */
export const PHOTO_MODERATION_TIMEOUT_MS = 8_000;

export const PHOTO_FLAGS = ["people", "lighting", "not_park", "inappropriate", "not_photo", "personal_info"] as const;
export type PhotoFlag = (typeof PHOTO_FLAGS)[number];

export const FLAG_MESSAGES: Record<PhotoFlag, string> = {
  people: "We spotted people. Take one without anyone in it.",
  lighting: "It's too dark or blurry. Take one in good light and hold the phone steady.",
  not_park: "That doesn't look like the park. Point the camera at the park itself.",
  inappropriate: "This photo can't be used. Take a photo of the park itself.",
  not_photo: "That looks like a screen or an edited image. Take a fresh photo of the park.",
  personal_info: "We can read personal details, like a licence plate or a house number. Take one without them.",
};

export const UNSURE_MESSAGE = "We couldn't tell. Try another angle.";
export const UNAVAILABLE_MESSAGE = "We couldn't check your photo. Try again in a moment.";

function flagQuestion(instructions: string, yes: string, no: string): ModerationQuestion {
  return { type: "choice", instructions, criteria: { yes, no } };
}

export const PHOTO_QUESTIONS: Record<"verdict" | PhotoFlag, ModerationQuestion> = {
  verdict: {
    type: "choice",
    instructions: "Can this photo be used as the public cover photo of a park in a family-friendly game?",
    criteria: {
      approve: "A clear, well-lit, ordinary outdoor photo of the park itself (grass, trees, paths, water, play areas or views) with nobody in it and nothing personal or offensive.",
      reject: "It is not a usable public cover photo of a park.",
      unsure: "It is not possible to tell.",
    },
  },
  people: flagQuestion(
    "Are any people visible anywhere in the photo, including small or distant figures, faces, body parts such as hands, or people in reflections?",
    "At least one person, face or body part is visible.",
    "No people at all.",
  ),
  lighting: flagQuestion(
    "Judge only the light and sharpness, not what the photo shows. Is it too dark to see the place clearly (taken at night or in deep shade), washed out by glare or overexposure, or blurry or out of focus?",
    "Too dark to see the place clearly, at night or in deep shade, or washed out, or blurry.",
    "Bright and sharp enough to see clearly, whatever it shows.",
  ),
  not_park: flagQuestion(
    "Does the photo fail to show an outdoor park, garden or natural space? For example a wall, the ground up close, an indoor room, a vehicle, a street, a station, a close-up of an object, food, or only the sky.",
    "It does not show an outdoor park or natural space.",
    "It shows an outdoor park, garden or natural space.",
  ),
  inappropriate: flagQuestion(
    "Does the photo show nudity or sexual content, violence, blood, weapons, rude or offensive gestures, hateful symbols, offensive text or graffiti, or drugs?",
    "Something inappropriate for a family-friendly game is visible.",
    "Nothing inappropriate.",
  ),
  not_photo: flagQuestion(
    "Is this something other than an ordinary camera photo of a real place? For example a screenshot, a photo of a screen or monitor, a printed picture or poster, a map, a drawing, a meme, or an image with added captions, stickers or watermarks.",
    "Not an ordinary camera photo.",
    "An ordinary camera photo of a real place.",
  ),
  personal_info: flagQuestion(
    "Can any personal information be read in the photo, such as a vehicle licence plate, a house number on a home, a document, a name badge, or a phone screen? Park names and trail signs do not count.",
    "Personal information can be read.",
    "No readable personal information.",
  ),
};

export function photoApproveThreshold(value: string | undefined): number {
  const number = value === undefined || value.trim() === "" ? NaN : Number(value);
  return Number.isFinite(number) && number >= 0.5 && number <= 1 ? number : DEFAULT_PHOTO_APPROVE_THRESHOLD;
}

export interface PhotoAnswers {
  model: string;
  /** Per question, the probability of each label. */
  answers: Record<string, { choice: string; probabilities: Record<string, number> }>;
}

export type PhotoDecision =
  | { outcome: "approve"; flags: [] }
  | { outcome: "reject"; flags: PhotoFlag[] }
  | { outcome: "unsure"; flags: [] };

function probability(answer: PhotoAnswers["answers"][string] | undefined, label: string): number {
  if (!answer) return 0;
  const value = answer.probabilities[label];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return answer.choice === label ? 1 : 0;
}

/**
 * Approve only when the verdict is `approve` with at least the threshold and no flag is yes.
 * Any flag gives a rejection naming those flags, most likely first. Anything else is unsure.
 */
export function decidePhoto(result: PhotoAnswers, threshold: number): PhotoDecision {
  const flags = PHOTO_FLAGS
    .map((flag) => ({ flag, p: probability(result.answers[flag], "yes") }))
    .filter((item) => item.p > FLAG_THRESHOLD)
    .sort((a, b) => b.p - a.p)
    .map((item) => item.flag);
  if (flags.length) return { outcome: "reject", flags };
  const verdict = result.answers.verdict;
  const top = verdict ? Object.entries(verdict.probabilities).sort((a, b) => b[1] - a[1])[0]?.[0] ?? verdict.choice : null;
  if (top === "approve" && probability(verdict, "approve") >= threshold) return { outcome: "approve", flags: [] };
  return { outcome: "unsure", flags: [] };
}

export interface PhotoCheckInput {
  jpeg: Uint8Array;
  parkName: string;
  /** What kind of place, such as leisure=park or municipal. */
  parkKind: string;
}

export type PhotoChecker = (input: PhotoCheckInput) => Promise<PhotoAnswers | null>;

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** The state sent to the model: a short context line and the image. Never personal data. */
export function photoState(input: PhotoCheckInput): unknown[] {
  return [
    {
      type: "text",
      text: `A player standing in a park took this photo to become the park's public cover photo in a family-friendly park game. The park is called ${input.parkName} (${input.parkKind}).`,
    },
    { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64(input.jpeg)}` } },
  ];
}

/** Null without OPENROUTER_API_KEY, so the route answers "try again" instead of approving blind. */
export function createPhotoChecker(env: ModerationEnv, fetcher?: ModerationFetch, timeoutMs = PHOTO_MODERATION_TIMEOUT_MS): PhotoChecker {
  return async (input) => {
    const result = await moderate({ kind: "founder_photo", state: photoState(input), questions: PHOTO_QUESTIONS }, env, fetcher, timeoutMs);
    if (!result) return null;
    const answers: PhotoAnswers["answers"] = {};
    for (const [name, answer] of Object.entries(result.answers) as [string, ModerationAnswer][]) {
      if (answer.type !== "choice") return null;
      answers[name] = { choice: answer.choice, probabilities: answer.probabilities };
    }
    return { model: result.model, answers };
  };
}
