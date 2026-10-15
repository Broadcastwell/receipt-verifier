import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputError, parseInput, parseRecordId } from '../src/parse.js';
import { fixtureJson } from './helpers/fixture-fetch.js';

const OBSERVATION = 'observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f';
const TOKEN = 'b23fe6796b7ca46de946a75e758de540092c9941247f05314d57d44d5aea3612';
const HASH = 'b8323d7db281e60928624288b2a6f0c3b52d4742174fb4ad52302d1aedb0beb5';

test('record ids', () => {
  assert.deepEqual(parseRecordId('crm|1|ChatGPT|1'), { category: 'crm', question: '1', engine: 'ChatGPT', run: 1, recordId: 'crm|1|ChatGPT|1' });
  assert.deepEqual(parseInput('construction-project-management|q1|Google AI Mode|1').ids, { category: 'construction-project-management', question: 'q1', engine: 'Google AI Mode', run: 1, recordId: 'construction-project-management|q1|Google AI Mode|1' });
  assert.equal(parseInput('project_management|10|Google AI Overviews|3').recordId, 'project_management|10|Google AI Overviews|3');
  assert.equal(parseInput('crm|control-1|Claude|2').ids.question, 'control-1');
  assert.equal(parseInput('  crm|1|ChatGPT|1  ').kind, 'index');
  assert.equal(parseInput('crm%7C1%7CChatGPT%7C1').recordId, 'crm|1|ChatGPT|1');
  for (const bad of ['crm|1|ChatGPT', 'crm|1|ChatGPT|1|x', 'CRM!|1|ChatGPT|1', 'crm|1||1', 'crm|1|ChatGPT|run', 'crm|1|ChatGPT|0']) {
    assert.equal(parseRecordId(bad), null, bad);
  }
});

test('receipt URLs for the Index', () => {
  const page = parseInput('https://broadcastwell.github.io/receipt-verifier/?record=crm%7C1%7CChatGPT%7C1');
  assert.equal(page.kind, 'index');
  assert.equal(page.recordId, 'crm|1|ChatGPT|1');
  const spaced = parseInput('https://broadcastwell.github.io/receipt-verifier/?record=construction-project-management%7Cq1%7CGoogle%20AI%20Mode%7C1');
  assert.equal(spaced.ids.engine, 'Google AI Mode');
  const fragment = parseInput('https://index.broadcastwell.com/categories/crm/#crm|1|ChatGPT|1');
  assert.equal(fragment.recordId, 'crm|1|ChatGPT|1');
  const encoded = parseInput('https://index.broadcastwell.com/categories/construction-project-management/#construction-project-management%7Cq1%7CGoogle%20AI%20Mode%7C1');
  assert.equal(encoded.ids.engine, 'Google AI Mode');
});

test('Decision Receipt and Public Fix links', () => {
  assert.deepEqual(parseInput('https://app.broadcastwell.com/s/' + TOKEN), { kind: 'decision', token: TOKEN, hash: null });
  assert.deepEqual(parseInput('https://app.broadcastwell.com/s/' + TOKEN + '?verify=' + HASH), { kind: 'decision', token: TOKEN, hash: HASH });
  assert.deepEqual(parseInput('https://app.broadcastwell.com/s/' + TOKEN + '?verify=' + HASH.toUpperCase()).hash, HASH);
  assert.deepEqual(parseInput('https://app.broadcastwell.com/public-fix/broadcastwell'), { kind: 'publicfix', slug: 'broadcastwell' });
  assert.deepEqual(parseInput('https://app.broadcastwell.com/api/v1/public-fix/broadcastwell'), { kind: 'publicfix', slug: 'broadcastwell' });
  assert.deepEqual(parseInput('https://broadcastwell.com/public-fix/broadcastwell/'), { kind: 'publicfix', slug: 'broadcastwell' });
});

test('sample ids and links', () => {
  assert.deepEqual(parseInput('sample:' + OBSERVATION), { kind: 'sample', observationId: OBSERVATION });
  assert.deepEqual(parseInput(OBSERVATION), { kind: 'sample', observationId: OBSERVATION });
  assert.deepEqual(parseInput('https://example.com/receipts/' + OBSERVATION), { kind: 'sample', observationId: OBSERVATION });
  assert.deepEqual(parseInput('https://app.broadcastwell.com/api/export/kalvenor-monitor.json#' + OBSERVATION), { kind: 'sample', observationId: OBSERVATION });
});

test('this page, given another receipt link', () => {
  const inner = 'https://app.broadcastwell.com/s/' + TOKEN + '?verify=' + HASH;
  const parsed = parseInput('https://broadcastwell.github.io/receipt-verifier/?receipt=' + encodeURIComponent(inner));
  assert.deepEqual(parsed, { kind: 'decision', token: TOKEN, hash: HASH });
});

test('receipt JSON in all three shapes, as objects and as text', () => {
  const index = fixtureJson('index-receipt-crm-1-ChatGPT-1.json');
  assert.equal(parseInput(index).kind, 'index');
  assert.equal(parseInput(JSON.stringify(index)).receipt.answer_sha256, index.answer_sha256);
  assert.equal(parseInput({ name: 'HubSpot CRM', receipt: index }).kind, 'index');
  const sample = fixtureJson('sample-receipt-' + OBSERVATION + '.json');
  assert.equal(parseInput(sample).kind, 'sample');
  assert.equal(parseInput(sample).observationId, OBSERVATION);
  const observation = fixtureJson('sample-export-kalvenor-monitor.json').observations[0];
  assert.equal(parseInput(observation).kind, 'sample');
  const decision = fixtureJson('decision-receipt-public-fix.json');
  const parsed = parseInput(decision);
  assert.equal(parsed.kind, 'decision');
  assert.equal(parsed.token, TOKEN);
});

test('input errors are InputError with a plain message', () => {
  const bad = [
    '', '   ', 'hello', 42, null, [], '{not json', 'https://example.com/',
    'https://example.com/s/' + TOKEN, 'sample:nothing', 'ftp://app.broadcastwell.com/s/' + TOKEN,
    { something: 'else' }, { receipts_url: 'https://example.com/s/' + TOKEN, hash: HASH },
    { record_id: 'not a record id' }, 'https://broadcastwell.github.io/receipt-verifier/?record=nope'
  ];
  for (const input of bad) {
    assert.throws(() => parseInput(input), error => error instanceof InputError && error.name === 'InputError' && error.message.length > 0, JSON.stringify(input));
  }
  assert.throws(() => parseInput('x'.repeat(200001)), InputError);
  assert.throws(() => parseInput(OBSERVATION + 'x'), InputError);
  assert.throws(() => parseInput('sample:' + OBSERVATION + 'x'), InputError);
});
