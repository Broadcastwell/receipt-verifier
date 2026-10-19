// The software DOI minted by Zenodo for the v1.0.0 GitHub release (19 Oct 2026): the concept DOI
// resolves to the latest version, the version DOI to v1.0.0 itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CONCEPT = '10.5281/zenodo.23465305';
const V100 = '10.5281/zenodo.23465306';
const read = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('the README carries the DOI badge and states the v1.0.0 DOI', () => {
  const readme = read('README.md');
  assert.ok(readme.includes('[![DOI](https://zenodo.org/badge/DOI/' + CONCEPT + '.svg)](https://doi.org/' + CONCEPT + ')'));
  assert.ok(readme.includes('https://doi.org/' + V100));
  assert.equal(readme.includes('DOI badge: added after'), false, 'the placeholder comment is gone');
});

test('CITATION.cff names the software DOI', () => {
  assert.match(read('CITATION.cff'), new RegExp('^doi: ' + CONCEPT.replace(/[.]/g, '[.]') + '$', 'm'));
});
