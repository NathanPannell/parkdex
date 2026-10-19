import { choiceFlags, moderate, type ModerationEnv, type ModerationFetch, type ModerationQuestion } from "./moderation.js";

/**
 * Handle rules for the flag game: format, a small blocklist, then the moderation model when
 * OPENROUTER_API_KEY is set. Handles are public on the leaderboard and map.
 */

export const HANDLE_PATTERN = /^[a-z0-9_]{3,20}$/;

// Matched anywhere in the handle after normalising. Only terms that do not occur inside
// ordinary words belong here.
const SUBSTRING_TERMS = [
  "fuck",
  "shit",
  "cunt",
  "bitch",
  "whore",
  "slut",
  "dick",
  "pussy",
  "penis",
  "vagina",
  "porn",
  "nigger",
  "nigga",
  "faggot",
  "retard",
  "tranny",
  "chink",
  "kike",
  "wetback",
  "nazi",
  "hitler",
  "kkk",
  "jizz",
  "dildo",
  "blowjob",
  "handjob",
  "boner",
  "pedophil",
  "molest",
  "incest",
  "bestial",
  "milf",
  "hentai",
  "nude",
  "naked",
  "horny",
  "killyou",
  "parkdex",
  "moderator",
];

// Matched only as a whole handle or a whole word between underscores or digits, because they
// appear inside innocent words (classic, document, peacock, spicy, canal, torpedo, therapist,
// badminton, skipper).
const TOKEN_TERMS = [
  "ass",
  "arse",
  "cum",
  "fag",
  "rape",
  "sex",
  "tit",
  "tits",
  "coon",
  "gook",
  "homo",
  "dyke",
  "twat",
  "piss",
  "crap",
  "kys",
  "isis",
  "cock",
  "spic",
  "anal",
  "pedo",
  "rapist",
  "admin",
  "kip",
  "mod",
  "staff",
  "support",
  "official",
  "system",
  "root",
];

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "9": "g", "2": "z", "6": "g" };

function collapseRepeats(value: string): string {
  return value.replace(/(.)\1+/g, "$1");
}

/** The spellings a handle is checked under: as typed, digits dropped, and digits read as letters. */
export function handleVariants(handle: string): { compact: string[]; tokens: string[] } {
  const lettersOnly = handle.replace(/[^a-z_]/g, "_");
  const leet = handle.replace(/[0-9]/g, (digit) => LEET[digit] ?? digit);
  const compact = new Set<string>();
  const tokens = new Set<string>();
  for (const spelling of [lettersOnly, leet]) {
    const joined = spelling.replace(/_/g, "");
    compact.add(joined);
    compact.add(collapseRepeats(joined));
    for (const token of spelling.split("_")) if (token) tokens.add(token);
    tokens.add(joined);
  }
  return { compact: [...compact], tokens: [...tokens] };
}

/** True when the normalised handle hits the blocklist. */
export function blocklisted(handle: string): boolean {
  const { compact, tokens } = handleVariants(handle);
  if (SUBSTRING_TERMS.some((term) => compact.some((value) => value.includes(term)))) return true;
  return TOKEN_TERMS.some((term) => tokens.includes(term));
}

export function normalizeHandle(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

export const HANDLE_QUESTION: ModerationQuestion = {
  type: "choice",
  instructions:
    "This is a player nickname that will be shown publicly on the leaderboard and map of a park visiting game played by friends. Decide whether it is acceptable.",
  criteria: {
    allow: "An ordinary nickname for a public park game leaderboard.",
    reject:
      "Contains or implies slurs, sexual content, harassment, hate, threats, impersonation of staff or brands, or personal information such as a phone number or address.",
    unsure: "Cannot tell whether it is acceptable.",
  },
};

export type HandleVerdict = { allowed: boolean; source: "blocklist" | "model" | "blocklist_only" };

/** Blocklist first; the model only sees handles that pass it, and its absence never blocks a handle. */
export async function checkHandle(handle: string, env: ModerationEnv, fetchImpl?: ModerationFetch): Promise<HandleVerdict> {
  if (blocklisted(handle)) return { allowed: false, source: "blocklist" };
  const result = await moderate({ kind: "handle", state: { handle }, questions: { handle: HANDLE_QUESTION } }, env, fetchImpl);
  if (!result) return { allowed: true, source: "blocklist_only" };
  return { allowed: !choiceFlags(result.answers.handle, "reject", 0.5), source: "model" };
}
