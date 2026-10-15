import { test } from 'node:test';
import assert from 'node:assert/strict';
import { excerptCore, plain } from '../src/plain.js';
import { fixtureBytes, fixtureJson } from './helpers/fixture-fetch.js';

test('plain() keeps link text and drops markdown marks', () => {
  assert.equal(plain('See [HubSpot](https://hubspot.com) now'), 'See HubSpot now');
  assert.equal(plain('a ([source](https://x.example/a)) b'), 'a (source) b');
  assert.equal(plain('**Bold** and _it_ and `code`'), 'Bold and it and code');
  assert.equal(plain('## Heading\n> quote | cell |'), 'Heading quote cell');
  assert.equal(plain('  many\n\n  spaces\t here  '), 'many spaces here');
  assert.equal(plain('non' + String.fromCharCode(0xa0) + 'breaking'), 'non breaking');
  assert.equal(plain(42), '42');
});

test('excerptCore() removes only the cut marks', () => {
  assert.equal(excerptCore('... middle words ...'), 'middle words');
  assert.equal(excerptCore('start words ...'), 'start words');
  assert.equal(excerptCore('... end words'), 'end words');
  assert.equal(excerptCore('whole answer'), 'whole answer');
  assert.equal(excerptCore('...no space'), '...no space');
});

test('the published excerpt is a substring of plain() of the published answer', () => {
  const receipt = fixtureJson('index-receipt-crm-1-ChatGPT-1.json');
  const record = JSON.parse(fixtureBytes('answers-crm-1-ChatGPT-1.jsonl').toString('utf8'));
  assert.ok(plain(record.answer_text).includes(excerptCore(receipt.excerpt)));
  assert.ok(!record.answer_text.includes(excerptCore(receipt.excerpt)), 'the raw answer is markdown; only plain() makes the excerpt match');
});
