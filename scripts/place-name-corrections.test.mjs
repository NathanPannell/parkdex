import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasBalancedNameDelimiters, provincialNameCorrections } from './place-name-corrections.mjs';

test('display name delimiter validation catches incomplete imported aliases', () => {
  for (const name of ['Park [aka Other', 'Park (Other]', 'Park ]Other[']) assert.equal(hasBalancedNameDelimiters(name), false);
  for (const name of ['Park (Other)', 'Park [aka Other]', 'Háthayim Marine Park']) assert.equal(hasBalancedNameDelimiters(name), true);
});
test('correcting source 728 preserves the original saved-progress identity', () => {
  assert.equal(provincialNameCorrections.get('728').id, 'provincial-hathayim-marine-park-a-k-a-von-donop-marine-park');
});
