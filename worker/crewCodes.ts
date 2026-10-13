/**
 * Crew codes (#170): 6 characters from the friend code alphabet, which leaves out 0, 1, I, L
 * and O. `kip_game.random_crew_code()` in game_003_crews.sql draws from the same alphabet.
 * The friends PR (#190) adds the shared `worker/socialCodes.ts`; once both have merged this
 * module can use its SOCIAL_CODE_ALPHABET and normalizeSocialCode(input, 6) instead.
 */
export const CREW_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** A crew code lives for one protected hour, so 6 characters are enough. */
export const CREW_CODE_LENGTH = 6;

/** The code in its stored form (upper case, no spaces or dashes), or null when it cannot be one. */
export function normalizeCrewCode(input: string): string | null {
  if (input.length > 64) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== CREW_CODE_LENGTH) return null;
  for (const character of code) {
    if (!CREW_CODE_ALPHABET.includes(character)) return null;
  }
  return code;
}
