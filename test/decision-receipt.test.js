import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verify } from '../src/index.js';
import { NETWORK_REASON, publicFixUrl, shareUrl } from '../src/sources.js';
import { createFixtureFetch, fixtureJson, jsonResponse, reasonOf, statusOf } from './helpers/fixture-fetch.js';

const RECEIPT = fixtureJson('decision-receipt-public-fix.json');
const TOKEN = /\/s\/([0-9a-f]{64})$/.exec(RECEIPT.receipts_url)[1];
const NOT_PUBLIC = 'the answer texts of a shared run are not public';

test('the Public Fix Decision Receipt is VERIFIED, with excerpt and cited pages NOT CHECKABLE', async () => {
  const report = await verify('https://app.broadcastwell.com/public-fix/broadcastwell', { fetch: createFixtureFetch().fetch });
  assert.equal(report.verdict, 'VERIFIED');
  assert.equal(report.kind, 'decision');
  assert.equal(statusOf(report, 'record'), 'PASS');
  assert.equal(statusOf(report, 'hash'), 'PASS');
  assert.match(reasonOf(report, 'hash'), /printed on the share page/);
  assert.equal(statusOf(report, 'excerpt'), 'NOT CHECKABLE');
  assert.equal(reasonOf(report, 'excerpt'), NOT_PUBLIC);
  assert.equal(statusOf(report, 'cited_pages'), 'NOT CHECKABLE');
  assert.equal(reasonOf(report, 'cited_pages'), NOT_PUBLIC);
  assert.deepEqual(report.receipt, { receipts_url: RECEIPT.receipts_url, hash: RECEIPT.hash });
  assert.ok(report.sources.includes(publicFixUrl('broadcastwell')));
});

test('every link form of the same Decision Receipt gives one verification id', async () => {
  const ids = [];
  for (const input of [
    'https://app.broadcastwell.com/public-fix/broadcastwell',
    'https://app.broadcastwell.com/api/v1/public-fix/broadcastwell',
    RECEIPT.receipts_url,
    RECEIPT.receipts_url + '?verify=' + RECEIPT.hash
  ]) {
    const report = await verify(input, { fetch: createFixtureFetch().fetch });
    assert.equal(report.verdict, 'VERIFIED', input);
    ids.push(report.verification_id);
  }
  assert.equal(new Set(ids).size, 1);
});

test('the Decision Receipt JSON is VERIFIED and its run is compared', async () => {
  const report = await verify(RECEIPT, { fetch: createFixtureFetch().fetch });
  assert.equal(report.verdict, 'VERIFIED');
  assert.equal(statusOf(report, 'run'), 'PASS');
  const other = await verify(Object.assign({}, RECEIPT, { run_id: 'job:another' }), { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(other, 'run'), 'FAIL');
  assert.equal(other.verdict, 'FAILED');
});

test('the wrong-hash Decision Receipt is FAILED on hash', async () => {
  const report = await verify(fixtureJson('tampered-decision-hash.json'), { fetch: createFixtureFetch().fetch });
  assert.equal(report.verdict, 'FAILED');
  assert.equal(statusOf(report, 'hash'), 'FAIL');
  assert.equal(statusOf(report, 'record'), 'PASS');
  const link = await verify(RECEIPT.receipts_url + '?verify=' + fixtureJson('tampered-decision-hash.json').hash, { fetch: createFixtureFetch().fetch });
  assert.equal(link.verdict, 'FAILED');
});

test('when the share page cannot be read, the hash the app reports is used', async () => {
  const { fetch } = createFixtureFetch({ overrides: { [shareUrl(TOKEN)]: () => new Response('busy', { status: 503 }) } });
  const report = await verify(RECEIPT.receipts_url, { fetch });
  assert.equal(report.verdict, 'VERIFIED');
  assert.match(reasonOf(report, 'hash'), /the app reports for this link/);
  assert.equal(report.receipt_source, 'app');
});

test('a network failure gives NOT CHECKABLE, never FAIL', async () => {
  for (const input of ['https://app.broadcastwell.com/public-fix/broadcastwell', RECEIPT.receipts_url, RECEIPT]) {
    const report = await verify(input, { fetch: createFixtureFetch({ offline: ['https://'] }).fetch });
    assert.equal(report.verdict, 'INCOMPLETE', JSON.stringify(input));
    assert.equal(report.checks.filter(check => check.status === 'FAIL').length, 0);
    assert.equal(reasonOf(report, 'record'), NETWORK_REASON);
  }
});

test('an unknown Public Fix run or share link is FAILED on record', async () => {
  const missing = createFixtureFetch({ overrides: { [publicFixUrl('nobody')]: () => jsonResponse({ error: 'not found' }, 404) } });
  const fix = await verify('https://app.broadcastwell.com/public-fix/nobody', { fetch: missing.fetch });
  assert.equal(statusOf(fix, 'record'), 'FAIL');
  const token = 'a'.repeat(64);
  const gone = createFixtureFetch({ overrides: { [shareUrl(token)]: () => new Response('not found', { status: 404 }) } });
  const link = await verify(shareUrl(token), { fetch: gone.fetch });
  assert.equal(statusOf(link, 'record'), 'FAIL');
  assert.equal(link.verdict, 'FAILED');
});

test('a receipt that names another hash algorithm fails on hash', async () => {
  const report = await verify(Object.assign({}, RECEIPT, { algorithm: 'SHA-1' }), { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(report, 'hash'), 'FAIL');
  assert.equal(report.verdict, 'FAILED');
});

test('a hash that is not hex fails without asking the app to compare it', async () => {
  const report = await verify(Object.assign({}, RECEIPT, { hash: 'abc' }), { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(report, 'hash'), 'FAIL');
});
