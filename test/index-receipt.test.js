import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verify } from '../src/index.js';
import { ANSWERS_URL, DOI_URL, LOCATOR, NETWORK_REASON, SUMS_URL, categoryUrl, zenodoFileUrl } from '../src/sources.js';
import { createFixtureFetch, fixtureBytes, fixtureJson, jsonResponse, reasonOf, statusOf } from './helpers/fixture-fetch.js';

const RECORD = 'crm|1|ChatGPT|1';
const CHECK_IDS = ['record', 'hash', 'excerpt', 'cited_pages', 'engine', 'question', 'run', 'captured_at', 'doi'];
const RECEIPT = fixtureJson('index-receipt-crm-1-ChatGPT-1.json');
const LINE = fixtureBytes('answers-crm-1-ChatGPT-1.jsonl');

test('the real Index receipt, given by its record id, is VERIFIED', async () => {
  const { fetch, calls } = createFixtureFetch();
  const report = await verify(RECORD, { fetch });
  assert.equal(report.verdict, 'VERIFIED');
  assert.equal(report.kind, 'index');
  assert.deepEqual(report.checks.map(check => check.id), CHECK_IDS);
  for (const check of report.checks) assert.equal(check.status, 'PASS', check.id + ': ' + check.reason);
  assert.equal(report.receipt_source, 'api');
  assert.deepEqual(report.receipt, RECEIPT);
  assert.match(report.verification_id, /^[0-9a-f]{64}$/);
  assert.ok(report.sources.includes(categoryUrl('crm')));
  const reads = calls.filter(call => call.url === ANSWERS_URL);
  assert.equal(reads.length, 1, 'one read of the answers file');
  assert.match(reads[0].range, /^bytes=[0-9]+-[0-9]+$/, 'the default path reads one record by byte range');
});

test('the receipt JSON as given is VERIFIED with the same verification id as its record id', async () => {
  const byId = await verify(RECORD, { fetch: createFixtureFetch().fetch });
  const byJson = await verify(RECEIPT, { fetch: createFixtureFetch().fetch });
  const byText = await verify(JSON.stringify(RECEIPT), { fetch: createFixtureFetch().fetch });
  assert.equal(byJson.verdict, 'VERIFIED');
  assert.equal(byJson.receipt_source, 'given');
  assert.equal(byJson.verification_id, byId.verification_id);
  assert.equal(byText.verification_id, byId.verification_id);
});

test('the same input gives the same verification id twice', async () => {
  const first = await verify(RECORD, { fetch: createFixtureFetch().fetch });
  await new Promise(resolve => setTimeout(resolve, 5));
  const second = await verify(RECORD, { fetch: createFixtureFetch().fetch });
  assert.equal(first.verification_id, second.verification_id);
  assert.notEqual(first.checked_at, undefined);
});

test('the tampered hash receipt is FAILED on hash', async () => {
  const report = await verify(fixtureJson('tampered-index-hash.json'), { fetch: createFixtureFetch().fetch });
  assert.equal(report.verdict, 'FAILED');
  assert.equal(statusOf(report, 'hash'), 'FAIL');
  assert.equal(statusOf(report, 'record'), 'PASS');
  assert.equal(statusOf(report, 'excerpt'), 'PASS');
  assert.match(reasonOf(report, 'hash'), /the receipt states 3d40a97f/);
});

test('the tampered excerpt receipt is FAILED on excerpt', async () => {
  const report = await verify(fixtureJson('tampered-index-excerpt.json'), { fetch: createFixtureFetch().fetch });
  assert.equal(report.verdict, 'FAILED');
  assert.equal(statusOf(report, 'excerpt'), 'FAIL');
  assert.equal(statusOf(report, 'hash'), 'PASS');
});

test('a changed engine, run, capture time, question or cited page each fails its own check', async () => {
  const cases = [
    ['engine', { engine: 'Claude' }],
    ['run', { run: 2 }],
    ['captured_at', { captured_at: '2026-09-22T19:36:03Z' }],
    ['question', { question: RECEIPT.question.replace('growing', 'small') }],
    ['cited_pages', { cited_urls: RECEIPT.cited_urls.concat('https://example.com/not-cited') }]
  ];
  for (const [id, change] of cases) {
    const report = await verify(Object.assign({}, RECEIPT, change), { fetch: createFixtureFetch().fetch });
    assert.equal(statusOf(report, id), 'FAIL', id);
    assert.equal(report.verdict, 'FAILED', id);
    assert.equal(report.checks.filter(check => check.status === 'FAIL').length, 1, id + ' fails alone');
  }
});

test('a question_id that disagrees with the record fails even when the receipt quotes no question', async () => {
  const receipt = { record_id: RECORD, question_id: '7', answer_sha256: RECEIPT.answer_sha256 };
  const report = await verify(receipt, { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(report, 'question'), 'FAIL');
  assert.equal(report.verdict, 'FAILED');
});

test('a Zenodo record without a DOI field is NOT CHECKABLE on doi, not FAIL', async () => {
  const { fetch } = createFixtureFetch({
    offline: ['https://doi.org/'],
    overrides: { 'https://zenodo.org/api/records/22907695': () => jsonResponse({ message: 'temporarily unavailable' }) }
  });
  const report = await verify(RECORD, { fetch });
  assert.equal(statusOf(report, 'doi'), 'NOT CHECKABLE');
  assert.equal(report.verdict, 'VERIFIED');
});

test('a hash that is not hex fails, and a receipt without a hash is not checkable on hash', async () => {
  const bad = await verify(Object.assign({}, RECEIPT, { answer_sha256: 'not a digest' }), { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(bad, 'hash'), 'FAIL');
  const bare = Object.assign({}, RECEIPT);
  delete bare.answer_sha256;
  const report = await verify(bare, { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(report, 'hash'), 'NOT CHECKABLE');
  assert.equal(report.verdict, 'INCOMPLETE');
});

test('a network failure gives NOT CHECKABLE, never FAIL', async () => {
  for (const input of [RECORD, RECEIPT]) {
    const report = await verify(input, { fetch: createFixtureFetch({ offline: ['https://'] }).fetch });
    assert.equal(report.verdict, 'INCOMPLETE');
    assert.equal(report.checks.filter(check => check.status === 'FAIL').length, 0);
    assert.equal(statusOf(report, 'record'), 'NOT CHECKABLE');
    assert.equal(reasonOf(report, 'record'), NETWORK_REASON);
    assert.equal(reasonOf(report, 'doi'), NETWORK_REASON);
  }
});

test('a fetch that never answers times out as NOT CHECKABLE', async () => {
  const never = () => new Promise(() => {});
  const report = await verify(RECORD, { fetch: never, timeoutMs: 30 });
  assert.equal(report.verdict, 'INCOMPLETE');
  assert.equal(report.checks.filter(check => check.status === 'FAIL').length, 0);
});

test('Zenodo out of reach leaves the record NOT CHECKABLE while the API checks still run', async () => {
  const report = await verify(RECEIPT, { fetch: createFixtureFetch({ offline: ['https://zenodo.org/'] }).fetch });
  assert.equal(statusOf(report, 'record'), 'NOT CHECKABLE');
  assert.equal(statusOf(report, 'hash'), 'NOT CHECKABLE');
  assert.equal(statusOf(report, 'question'), 'PASS');
  assert.equal(statusOf(report, 'doi'), 'PASS');
  assert.equal(report.verdict, 'INCOMPLETE');
});

test('the DOI check reads the Zenodo record when the redirect cannot be read', async () => {
  const blocked = await verify(RECORD, { fetch: createFixtureFetch({ offline: ['https://doi.org/'] }).fetch });
  assert.equal(statusOf(blocked, 'doi'), 'PASS');
  assert.match(reasonOf(blocked, 'doi'), /Zenodo record was read instead/);
  const opaque = () => ({ status: 0, type: 'opaqueredirect', url: '', headers: new Headers() });
  const hidden = await verify(RECORD, { fetch: createFixtureFetch({ overrides: { [DOI_URL]: opaque } }).fetch });
  assert.equal(statusOf(hidden, 'doi'), 'PASS');
  const elsewhere = () => new Response(null, { status: 302, headers: { location: 'https://example.com/elsewhere' } });
  const wrong = await verify(RECORD, { fetch: createFixtureFetch({ overrides: { [DOI_URL]: elsewhere } }).fetch });
  assert.equal(statusOf(wrong, 'doi'), 'FAIL');
});

test('a record id the dataset does not hold is FAILED on record', async () => {
  const report = await verify('crm|11|ChatGPT|1', { fetch: createFixtureFetch().fetch });
  assert.equal(statusOf(report, 'record'), 'FAIL');
  assert.equal(report.verdict, 'FAILED');
  assert.equal(report.receipt_source, 'id');
  assert.deepEqual(report.receipt, { record_id: 'crm|11|ChatGPT|1' });
});

test('a record the API serves no receipt for is checked as the dataset record itself', async () => {
  const category = fixtureJson('index-category-crm.json');
  const strip = node => {
    if (Array.isArray(node)) node.forEach(strip);
    else if (node && typeof node === 'object') {
      delete node.receipt;
      Object.values(node).forEach(strip);
    }
  };
  strip(category.data);
  const { fetch } = createFixtureFetch({ overrides: { [categoryUrl('crm')]: () => jsonResponse(category) } });
  const report = await verify(RECORD, { fetch });
  assert.equal(report.receipt_source, 'dataset');
  assert.equal(statusOf(report, 'excerpt'), 'NOT CHECKABLE');
  assert.equal(reasonOf(report, 'excerpt'), 'no published excerpt for this record');
  assert.equal(statusOf(report, 'hash'), 'PASS');
  assert.equal(report.receipt.answer_sha256, RECEIPT.answer_sha256);
  assert.equal(report.receipt.question, RECEIPT.question);
  assert.equal(report.verdict, 'VERIFIED');
});

test('the question text falls back to the release file when the API cannot be read', async () => {
  const release = { categories: [{ id: 'crm', questions: fixtureJson('index-questions-crm.json') }] };
  const { fetch } = createFixtureFetch({
    offline: ['https://app.broadcastwell.com/'],
    overrides: { [zenodoFileUrl('release-2026-09.json')]: () => jsonResponse(release) }
  });
  const report = await verify(RECEIPT, { fetch });
  assert.equal(statusOf(report, 'question'), 'PASS');
  assert.match(reasonOf(report, 'question'), /release-2026-09\.json/);
  assert.equal(report.verdict, 'VERIFIED');
});

test('bytes at the located range that hold another record are not trusted', async () => {
  const other = Buffer.from(JSON.stringify({ category_id: 'crm', question_id: '2', engine: 'ChatGPT', repeat_index: 1, answer_text: 'x' }));
  const { fetch } = createFixtureFetch({ overrides: { [ANSWERS_URL]: () => new Response(other, { status: 206 }) } });
  const report = await verify(RECEIPT, { fetch });
  assert.equal(statusOf(report, 'record'), 'NOT CHECKABLE');
  assert.match(reasonOf(report, 'record'), /full check/);
  assert.equal(report.checks.filter(check => check.status === 'FAIL').length, 0);
});

// A small stand-in for the 9 MB answers file: two other records around the real crm|1|ChatGPT|1 line.
function wholeFile() {
  const before = Buffer.from(JSON.stringify({ category_id: 'crm', question_id: 'control-1', engine: 'Claude', repeat_index: 1, answer_text: 'a' }));
  const after = Buffer.from(JSON.stringify({ category_id: 'crm', question_id: '2', engine: 'Perplexity', repeat_index: 3, answer_text: 'b' }));
  const bytes = Buffer.concat([before, Buffer.from('\n'), LINE, Buffer.from('\n'), after, Buffer.from('\n')]);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const offsets = Object.assign({}, LOCATOR, { sha256, bytes: bytes.length, lines: 3, categories: { crm: [['1', 0, 1, before.length + 1, LINE.length]] } });
  return { bytes, sha256, offsets };
}

test('the full check reads the whole file, checks its SHA-256 and finds the record', async () => {
  const { bytes, sha256, offsets } = wholeFile();
  const { fetch, calls } = createFixtureFetch({
    overrides: {
      [SUMS_URL]: () => new Response(sha256 + '  answers-2026-09.jsonl\n'),
      [ANSWERS_URL]: init => {
        assert.equal(new Headers(init.headers).get('range'), null, 'the full check asks for the whole file');
        return new Response(bytes);
      }
    }
  });
  const report = await verify(RECORD, { fetch, full: true, offsets });
  assert.equal(report.verdict, 'VERIFIED');
  assert.match(reasonOf(report, 'record'), /whole answers-2026-09\.jsonl/);
  assert.equal(report.dataset.sha256, sha256);
  assert.ok(calls.some(call => call.url === SUMS_URL));
  const misplaced = Object.assign({}, offsets, { categories: { crm: [['1', 0, 1, 0, 10]] } });
  const scanned = await verify(RECORD, { fetch, full: true, offsets: misplaced });
  assert.equal(statusOf(scanned, 'record'), 'PASS', 'a record the locator misplaces is still found by scanning');
});

test('the full check does not trust a file whose SHA-256 differs from SHA256SUMS.txt', async () => {
  const { bytes, offsets } = wholeFile();
  const { fetch } = createFixtureFetch({
    overrides: {
      [SUMS_URL]: () => new Response('0'.repeat(64) + '  answers-2026-09.jsonl\n'),
      [ANSWERS_URL]: () => new Response(bytes)
    }
  });
  const report = await verify(RECORD, { fetch, full: true, offsets });
  assert.equal(statusOf(report, 'record'), 'NOT CHECKABLE');
  assert.match(reasonOf(report, 'record'), /not the SHA-256/);
  assert.equal(report.verdict, 'INCOMPLETE');
});

test('fetch is never called as a method of another object, as browsers and Workers require', async () => {
  const fixtures = createFixtureFetch().fetch;
  const strict = function (url, init) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    return fixtures(url, init);
  };
  const report = await verify(RECORD, { fetch: strict });
  assert.equal(report.verdict, 'VERIFIED');
  const original = globalThis.fetch;
  globalThis.fetch = strict;
  try {
    assert.equal((await verify(RECORD)).verdict, 'VERIFIED', 'the global fetch is called on globalThis');
  } finally {
    globalThis.fetch = original;
  }
});

test('options are checked', async () => {
  await assert.rejects(() => verify(RECORD, { fetch: createFixtureFetch().fetch, offsets: { nothing: true } }), TypeError);
});
