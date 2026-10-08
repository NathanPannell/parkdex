/**
 * Shared content moderation through OpenRouter's Decisions API.
 *
 * Used for handles now, and for park proposals and drawn flag art later. Callers ask typed
 * questions and apply their own thresholds. Any failure returns null so callers can fall back
 * to their non-AI path (the handle blocklist, or the operator queue).
 */

export const MODERATION_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_MODERATION_MODEL = "openai/gpt-6-luna-decisions";
export const MODERATION_TIMEOUT_MS = 4_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface ModerationEnv {
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODERATION_MODEL?: string;
}

export type ModerationQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "noul"; instructions: string; criteria: { true: string; false: string } }
  | { type: "score"; instructions: string; criteria: string[] };

export type ModerationAnswer =
  | { type: "choice"; choice: string; confidence: number | null; probabilities: Record<string, number> }
  | { type: "noul"; noul: number }
  | { type: "score"; score: number; confidence: number | null; legend: unknown; probabilities: Record<string, number> };

export interface ModerationRequest {
  /** What is being judged, for example "handle" or "park_proposal". Never sent with personal data. */
  kind: string;
  /** The content to judge: text, an object, or an array that may include images. */
  state: unknown;
  questions: Record<string, ModerationQuestion>;
  /** Optional opaque end-user identifier for provider abuse tracking. Never an email or account ID. */
  user?: string;
}

export interface ModerationResult {
  kind: string;
  model: string;
  answers: Record<string, ModerationAnswer>;
}

export type ModerationFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function probabilities(value: unknown): Record<string, number> | null {
  if (!record(value)) return null;
  const output: Record<string, number> = {};
  for (const [label, probability] of Object.entries(value)) {
    if (!finiteNumber(probability) || probability < 0 || probability > 1) return null;
    output[label] = probability;
  }
  return output;
}

function parseAnswer(value: unknown): ModerationAnswer | null {
  if (!record(value)) return null;
  const confidence = finiteNumber(value.confidence) ? value.confidence : null;
  if (value.type === "choice" && typeof value.choice === "string") {
    const probs = probabilities(value.probabilities ?? {});
    return probs ? { type: "choice", choice: value.choice, confidence, probabilities: probs } : null;
  }
  if (value.type === "noul" && finiteNumber(value.noul)) return { type: "noul", noul: value.noul };
  if (value.type === "score" && finiteNumber(value.score)) {
    const probs = probabilities(value.probabilities ?? {});
    return probs ? { type: "score", score: value.score, confidence, legend: value.legend ?? null, probabilities: probs } : null;
  }
  return null;
}

/** Parses a Decisions API body. Every asked question must come back with a valid answer. */
export function parseModerationResponse(body: unknown, questionNames: string[]): { model: string; answers: Record<string, ModerationAnswer> } | null {
  if (!record(body) || record(body.error) || !record(body.answers)) return null;
  const answers: Record<string, ModerationAnswer> = {};
  for (const name of questionNames) {
    const answer = parseAnswer(body.answers[name]);
    if (!answer) return null;
    answers[name] = answer;
  }
  return { model: typeof body.model === "string" ? body.model : "", answers };
}

function moderationModel(env: ModerationEnv): string {
  const configured = env.OPENROUTER_MODERATION_MODEL?.trim();
  return configured && configured.length <= 200 ? configured : DEFAULT_MODERATION_MODEL;
}

/**
 * Asks the moderation model. Returns null when the key is missing, the call fails, the answer
 * is malformed, or it takes longer than the timeout. Never logs the key or the request body.
 */
export async function moderate(
  request: ModerationRequest,
  env: ModerationEnv,
  fetchImpl: ModerationFetch = fetch,
  timeoutMs = MODERATION_TIMEOUT_MS,
): Promise<ModerationResult | null> {
  const key = env.OPENROUTER_API_KEY?.trim();
  if (!key) return null;
  const questionNames = Object.keys(request.questions);
  if (questionNames.length === 0) return null;
  const model = moderationModel(env);
  const body: Record<string, unknown> = { model, state: request.state, questions: request.questions };
  if (request.user) body.user = request.user;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The race also covers fetch implementations that ignore the abort signal.
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve(null);
    }, timeoutMs);
  });
  const call = (async (): Promise<ModerationResult | null> => {
    try {
      const response = await fetchImpl(MODERATION_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
        redirect: "error",
      });
      if (!response.ok) return null;
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) return null;
      const parsed = parseModerationResponse(JSON.parse(text) as unknown, questionNames);
      return parsed ? { kind: request.kind, model: parsed.model || model, answers: parsed.answers } : null;
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** The label with the highest probability, falling back to the reported choice. */
export function topChoice(answer: Extract<ModerationAnswer, { type: "choice" }>): string {
  let best: string | null = null;
  let bestProbability = -1;
  for (const [label, probability] of Object.entries(answer.probabilities)) {
    if (probability > bestProbability) {
      best = label;
      bestProbability = probability;
    }
  }
  return best ?? answer.choice;
}

/** True when `label` is the most likely choice or its probability is above the threshold. */
export function choiceFlags(answer: ModerationAnswer | undefined, label: string, threshold = 0.5): boolean {
  if (!answer || answer.type !== "choice") return false;
  const probability = answer.probabilities[label];
  if (probability !== undefined && probability > threshold) return true;
  return topChoice(answer) === label;
}
