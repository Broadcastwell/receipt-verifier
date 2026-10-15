// Runs against the live public sources only when RV_LIVE=1. Public reads only: the Absence Index
// category API, Zenodo, the DOI resolver, the keyless sample export and the Public Fix share link.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { ANSWERS_URL, LOCATOR, locate } from '../src/sources.js';
import { createFixtureFetch, fixtureBytes, fixtureJson, reasonOf, statusOf } from './helpers/fixture-fetch.js';

const LIVE = process.env.RV_LIVE === '1';
const skip = LIVE ? false : 'set RV_LIVE=1 to run against the live sources';
const slow = { skip, timeout: 120000 };

test('live: the Index receipt crm|1|ChatGPT|1 is VERIFIED and matches its fixture', slow, async () => {
  const report = await verify('crm|1|ChatGPT|1');
  assert.equal(report.verdict, 'VERIFIED', JSON.stringify(report.checks));
  for (const check of report.checks) assert.equal(check.status, 'PASS', check.id + ': ' + check.reason);
  assert.deepEqual(report.receipt, fixtureJson('index-receipt-crm-1-ChatGPT-1.json'));
  const offline = await verify('crm|1|ChatGPT|1', { fetch: createFixtureFetch().fetch });
  assert.equal(report.verification_id, offline.verification_id, 'live and fixtures give one verification id');
});

test('live: the answers line at the located range is the fixture line, byte for byte', slow, async () => {
  const at = locate(LOCATOR, { category: 'crm', question: '1', engine: 'ChatGPT', run: 1 });
  const response = await fetch(ANSWERS_URL, { headers: { range: 'bytes=' + at.offset + '-' + (at.offset + at.length - 1), 'user-agent': 'receipt-verifier/1.0.0 (+https://github.com/Broadcastwell/receipt-verifier)' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixtureBytes('answers-crm-1-ChatGPT-1.jsonl'));
});

test('live: an Index record from another category is VERIFIED', slow, async () => {
  const report = await verify('construction-project-management|q1|Google AI Mode|1');
  assert.equal(report.verdict, 'VERIFIED', JSON.stringify(report.checks));
});

test('live: a record the API serves no receipt for is checked as the dataset record itself', slow, async () => {
  const report = await verify('crm|control-1|Claude|2');
  assert.equal(report.receipt_source, 'dataset');
  assert.equal(reasonOf(report, 'excerpt'), 'no published excerpt for this record');
  assert.equal(statusOf(report, 'question'), 'PASS');
  assert.equal(report.verdict, 'VERIFIED');
});

test('live: the sample receipt is VERIFIED with the DOI NOT CHECKABLE', slow, async () => {
  const report = await verify('observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f');
  assert.equal(report.verdict, 'VERIFIED', JSON.stringify(report.checks));
  assert.equal(reasonOf(report, 'doi'), 'the sample is fictional and has no DOI');
  assert.deepEqual(report.receipt, fixtureJson('sample-receipt-observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f.json'));
});

test('live: the Public Fix Decision Receipt is VERIFIED with excerpt and cited pages NOT CHECKABLE', slow, async () => {
  const report = await verify('https://app.broadcastwell.com/public-fix/broadcastwell');
  assert.equal(report.verdict, 'VERIFIED', JSON.stringify(report.checks));
  assert.equal(statusOf(report, 'excerpt'), 'NOT CHECKABLE');
  assert.equal(statusOf(report, 'cited_pages'), 'NOT CHECKABLE');
  const json = await verify(fixtureJson('decision-receipt-public-fix.json'));
  assert.equal(json.verdict, 'VERIFIED');
});

test('live: the tampered receipts are FAILED', slow, async () => {
  const hash = await verify(fixtureJson('tampered-index-hash.json'));
  assert.equal(hash.verdict, 'FAILED');
  assert.equal(statusOf(hash, 'hash'), 'FAIL');
  const excerpt = await verify(fixtureJson('tampered-index-excerpt.json'));
  assert.equal(excerpt.verdict, 'FAILED');
  assert.equal(statusOf(excerpt, 'excerpt'), 'FAIL');
  const decision = await verify(fixtureJson('tampered-decision-hash.json'));
  assert.equal(decision.verdict, 'FAILED');
  assert.equal(statusOf(decision, 'hash'), 'FAIL');
});

test('live: the full check reads the whole answers file and VERIFIES the receipt', { skip, timeout: 300000 }, async () => {
  const report = await verify('crm|1|ChatGPT|1', { full: true });
  assert.equal(report.verdict, 'VERIFIED', JSON.stringify(report.checks));
  assert.match(reasonOf(report, 'record'), /whole answers-2026-09\.jsonl/);
});
