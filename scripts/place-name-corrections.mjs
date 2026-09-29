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
  ['1027', {
    id: 'provincial-jaji7em-and-kw-ulh-marine-park',
    name: "Jáji7em and Kw'ulh Marine Park",
    alias: 'Also known as Sandy Island Marine Park.',
    region: 'Northern Vancouver Island',
    sourceUrl: 'https://bcparks.ca/jaji7em-and-kwulh-marine-park-aka-sandy-island-marine-park/',
  }],
  ['790', {
    id: 'provincial-khutzeymateen-park',
    name: 'Khutzeymateen Park',
    alias: "Also known as Khutzeymateen/K'tzim-a-deen Grizzly Sanctuary.",
    region: 'North Coast & Haida Gwaii',
    sourceUrl: 'https://bcparks.ca/khutzeymateen-park-aka-khutzeymateen-ktzim-a-deen-grizzly-sanctuary/',
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
