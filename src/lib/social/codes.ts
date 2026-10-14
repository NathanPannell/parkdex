/**
 * Short codes that people read aloud, type or scan: friend codes (#64) and crew codes (#170).
 * The alphabet leaves out 0, 1, I, L and O. It matches `worker/socialCodes.ts` and the
 * database's `kip_social.random_code`.
 */
export const SOCIAL_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

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

/** Splits a code in two halves for reading, for example ABCD-2345 or ABC-234. */
export function formatSocialCode(code: string): string {
  if (code.length < 6) return code;
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)}-${code.slice(half)}`;
}

/** Keeps only characters that can be in a code, upper-cased, for a text field as it is typed. */
export function cleanSocialCodeInput(input: string, length: number): string {
  let code = "";
  for (const character of input.toUpperCase()) {
    if (SOCIAL_CODE_ALPHABET.includes(character)) code += character;
    if (code.length === length) break;
  }
  return code;
}
