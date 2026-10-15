import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { NETWORK_REASON, SAMPLE_EXPORT_URL } from '../src/sources.js';
import { createFixtureFetch, fixtureJson, reasonOf, statusOf } from './helpers/fixture-fetch.js';

const OBSERVATION = 'observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f';
const RECEIPT = fixtureJson('sample-receipt-' + OBSERVATION + '.json');

test('the sample receipt is VERIFIED, with the DOI NOT CHECKABLE because the sample is fictional', async () => {
  const { fetch, calls } = createFixtureFetch();
  const report = await verify(OBSERVATION, { fetch });
  assert.equal(report.verdict, 'VERIFIED');
  assert.equal(report.kind, 'sample');
  assert.equal(report.receipt_source, 'export');
  assert.deepEqual(report.receipt, RECEIPT);
  assert.equal(statusOf(report, 'doi'), 'NOT CHECKABLE');
  assert.equal(reasonOf(report, 'doi'), 'the sample is fictional and has no DOI');
  for (const check of report.checks.filter(item => item.id !== 'doi')) assert.equal(check.status, 'PASS', check.id + ': ' + check.reason);
  assert.deepEqual(calls.map(call => call.url), [SAMPLE_EXPORT_URL]);
  assert.equal(report.dataset.fictional, true);
});

test('the sample id forms and the receipt JSON give one verification id', async () => {
  const ids = [];
  for (const input of [OBSERVATION, 'sample:' + OBSERVATION, RECEIPT, JSON.stringify(RECEIPT)]) {
    const report = await verify(input, { fetch: createFixtureFetch().fetch });
    assert.equal(report.verdict, 'VERIFIED');
    ids.push(report.verification_id);
  }
  assert.equal(new Set(ids).size, 1);
});

test('an observation copied from the export is accepted as a sample receipt', async () => {
  const observation = fixtureJson('sample-export-kalvenor-monitor.json').observations.find(item => item.id === OBSERVATION);
  const report = await verify(observation, { fetch: createFixtureFetch().fetch });
  assert.equal(report.verdict, 'VERIFIED');
  assert.equal(report.receipt.answer_text, observation.answer_full);
  assert.equal(report.receipt.pass_id, observation.run_id);
});

test('a changed answer text fails the hash and the excerpt', async () => {
  const report = await verify(Object.assign({}, RECEIPT, { answer_text: RECEIPT.answer_text.replace('offline', 'online') }), { fetch: createFixtureFetch().fetch });
  assert.equal(report.verdict, 'FAILED');
  assert.equal(statusOf(report, 'hash'), 'FAIL');
  assert.equal(statusOf(report, 'excerpt'), 'FAIL');
});

test('a stated answer hash is compared with the published answer', async () => {
  const right = await verify(Object.assign({}, RECEIPT, { answer_sha256: '2f0a3a1f8db6835bffdb4ed2ddd3cb7177d73a3b9152f446d7de8b1a0dcb570c' }), { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(right, 'hash'), 'PASS');
  const wrong = await verify(Object.assign({}, RECEIPT, { answer_sha256: '1f0a3a1f8db6835bffdb4ed2ddd3cb7177d73a3b9152f446d7de8b1a0dcb570c' }), { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(wrong, 'hash'), 'FAIL');
});

test('changed fields fail their own checks', async () => {
  const cases = [
    ['engine', { engine_label: 'Claude' }],
    ['engine', { engine: 'claude' }],
    ['run', { pass_id: '2026-06' }],
    ['run', { run_id: 'another-run' }],
    ['question', { question_text: 'What is a CRM?' }],
    ['captured_at', { observed_at: '2026-05-12T10:04:00.000Z' }],
    ['cited_pages', { cited_urls: ['https://example.com/'] }]
  ];
  for (const [id, change] of cases) {
    const report = await verify(Object.assign({}, RECEIPT, change), { fetch: createFixtureFetch().fetch });
    assert.equal(statusOf(report, id), 'FAIL', id + ' ' + JSON.stringify(change));
    assert.equal(report.verdict, 'FAILED');
  }
});

test('a question id that disagrees fails even without the question text', async () => {
  const receipt = Object.assign({}, RECEIPT, { question_id: 2 });
  delete receipt.question_text;
  const report = await verify(receipt, { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(report, 'question'), 'FAIL');
  assert.equal(report.verdict, 'FAILED');
});

test('an observation id the export does not hold is FAILED on record', async () => {
  const report = await verify('observation-00000000-0000-4000-8000-000000000000', { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(report, 'record'), 'FAIL');
  assert.equal(report.verdict, 'FAILED');
});

test('an unreachable export gives NOT CHECKABLE, never FAIL', async () => {
  const report = await verify(RECEIPT, { fetch: createFixtureFetch({ offline: ['https://'] }).fetch });
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.equal(reasonOf(report, 'record'), NETWORK_REASON);
  assert.equal(report.checks.filter(check => check.status === 'FAIL').length, 0);
});
