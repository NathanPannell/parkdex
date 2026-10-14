/**
 * Short codes that people read aloud, type or scan: friend codes (#64) and crew codes (#170).
 * The alphabet leaves out 0, 1, I, L and O, which are easy to confuse. `kip_social.random_code`
 * in social_001_friends.sql draws from the same alphabet, and `src/lib/social/codes.ts` mirrors it.
 */
export const SOCIAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Friend codes are permanent, so they are long enough that nobody can guess one. */
export const FRIEND_CODE_LENGTH = 8;

/** The code in its stored form (upper case, no spaces or dashes), or null when it cannot be one. */
export function normalizeSocialCode(input: string, length: number): string | null {
  if (input.length > 64) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, "");
  if (code.length !== length) return null;
  for (const character of code) {
    if (!SOCIAL_CODE_ALPHABET.includes(character)) return null;
  }
  return code;
}
