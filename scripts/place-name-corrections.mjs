// Display corrections are keyed by the authority's immutable source identity.
// Never derive a replacement catalogue ID from a corrected display name.
export const hathayimId = 'provincial-hathayim-marine-park-a-k-a-von-donop-marine-park';
export const provincialNameCorrections = new Map([
  ['728', {
    id: hathayimId,
    name: 'Háthayim Marine Park',
    alias: 'Also known as Von Donop Marine Park.',
    region: 'Discovery Islands',
    sourceUrl: 'https://bcparks.ca/hathayim-marine-park-aka-von-donop-marine-park/',
  }],
]);

export function hasBalancedNameDelimiters(name) {
  const pairs = { ')': '(', ']': '[', '}': '{' }, stack = [];
  for (const character of name) {
    if ('([{'.includes(character)) stack.push(character);
    else if (character in pairs && stack.pop() !== pairs[character]) return false;
  }
  return stack.length === 0;
}
