#!/usr/bin/env node
// Fetches the real public data the offline tests use, once, into test/fixtures/, and writes the tampered
// copies the tests must catch. Public reads only: the Absence Index category API, Zenodo, the keyless
// sample export (fictional company) and the Public Fix record with its share link. No key of any kind.
//
// Usage: node scripts/fetch-fixtures.mjs   (run scripts/build-offsets.mjs first)

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { plain, excerptCore } from '../src/plain.js';
import {
  ANSWERS_URL, DOI_URL, SAMPLE_EXPORT_URL, SUMS_URL, ZENODO_API_RECORD,
  categoryUrl, locate, publicFixUrl, shareUrl, shareVerifyUrl
} from '../src/sources.js';

const OUT = new URL('../test/fixtures/', import.meta.url);
const USER_AGENT = 'receipt-verifier/1.0.0 (+https://github.com/Broadcastwell/receipt-verifier)';
const RECORD_ID = 'crm|1|ChatGPT|1';
const OBSERVATION_ID = 'observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f';
const PUBLIC_FIX = 'broadcastwell';

const entries = [];
const sha256 = data => createHash('sha256').update(data).digest('hex');

function stop(message) {
  console.error('fetch-fixtures: ' + message);
  process.exit(1);
}

async function save(name, data) {
  await writeFile(new URL(name, OUT), data);
  return name;
}

// Fetches a URL, saves the body byte for byte and records it in the manifest the test fetch serves from.
async function capture(url, file, { range, expect = [200] } = {}) {
  const headers = { 'user-agent': USER_AGENT };
  if (range) headers.range = range;
  const response = await fetch(url, { headers });
  if (!expect.includes(response.status)) stop(url + ' answered ' + response.status);
  const body = Buffer.from(await response.arrayBuffer());
  await save(file, body);
  entries.push({ url, range: range || undefined, status: response.status, content_type: response.headers.get('content-type'), file });
  return body;
}

function flipHex(hex, at) {
  const digit = parseInt(hex[at], 16);
  return hex.slice(0, at) + ((digit + 1) % 16).toString(16) + hex.slice(at + 1);
}

const pretty = value => JSON.stringify(value, null, 2) + '\n';

async function main() {
  await mkdir(OUT, { recursive: true });
  const locator = JSON.parse(await readFile(new URL('../data/answers-2026-09.offsets.json', import.meta.url), 'utf8'));

  // Index: the category answer, its first receipt and question list, and the one answers line by Range.
  const category = JSON.parse((await capture(categoryUrl('crm'), 'index-category-crm.json')).toString('utf8'));
  const receipt = category.data.named_most[0].receipt;
  if (receipt.record_id !== RECORD_ID) stop('named_most[0].receipt is ' + receipt.record_id + ', not ' + RECORD_ID);
  await save('index-receipt-crm-1-ChatGPT-1.json', pretty(receipt));
  await save('index-questions-crm.json', pretty(category.data.questions));
  const at = locate(locator, { category: 'crm', question: '1', engine: 'ChatGPT', run: 1 });
  const range = 'bytes=' + at.offset + '-' + (at.offset + at.length - 1);
  const line = await capture(ANSWERS_URL, 'answers-crm-1-ChatGPT-1.jsonl', { range, expect: [206] });
  if (line.length !== at.length) stop('the range answered ' + line.length + ' bytes, not ' + at.length);
  const record = JSON.parse(line.toString('utf8'));
  if ([record.category_id, record.question_id, record.engine, record.repeat_index].join('|') !== RECORD_ID) stop('the range holds another record');
  if (sha256(record.answer_text) !== receipt.answer_sha256) stop('the live receipt hash does not match the live record');
  if (!plain(record.answer_text).includes(excerptCore(receipt.excerpt))) stop('the live excerpt is not in the live record');

  // Zenodo: the record, its checksums and the DOI redirect.
  await capture(ZENODO_API_RECORD, 'zenodo-record-22907695.json');
  await capture(SUMS_URL, 'zenodo-SHA256SUMS.txt');
  const doi = await fetch(DOI_URL, { redirect: 'manual', headers: { 'user-agent': USER_AGENT } });
  if (doi.status < 300 || doi.status > 399) stop(DOI_URL + ' answered ' + doi.status);
  entries.push({ url: DOI_URL, status: doi.status, location: doi.headers.get('location') });

  // Sample: the keyless export (Kalvenor Systems is fictional) and one receipt in the published shape.
  const exported = JSON.parse((await capture(SAMPLE_EXPORT_URL, 'sample-export-kalvenor-monitor.json')).toString('utf8'));
  const observation = exported.observations.find(item => item.id === OBSERVATION_ID);
  if (!observation) stop('the sample export has no ' + OBSERVATION_ID);
  await save('sample-receipt-' + OBSERVATION_ID + '.json', pretty({
    receipt_id: observation.id,
    run_id: exported.baseline_id,
    pass_id: observation.run_id,
    question_id: observation.question_id,
    question_text: observation.question_text,
    engine: observation.engine,
    engine_label: exported.summary.engine_labels[observation.engine],
    cited_urls: observation.cited_urls,
    answer_text: observation.answer_full,
    observed_at: observation.observed_at
  }));

  // Decision Receipt: the Public Fix record, its share page and the app's own verify answers.
  const fix = JSON.parse((await capture(publicFixUrl(PUBLIC_FIX), 'public-fix-broadcastwell.json')).toString('utf8'));
  const token = /\/s\/([0-9a-f]{64})$/.exec(fix.data.day0.receipts_url)[1];
  const page = (await capture(shareUrl(token), 'decision-share-page.html')).toString('utf8');
  const current = JSON.parse((await capture(shareVerifyUrl(token, ''), 'decision-verify-empty.json')).toString('utf8'));
  if (!page.includes(current.hash)) stop('the share page does not print the current hash');
  const matched = JSON.parse((await capture(shareVerifyUrl(token, current.hash), 'decision-verify-match.json')).toString('utf8'));
  if (matched.matches !== true) stop('the app does not confirm its own hash');
  await save('decision-receipt-public-fix.json', pretty({
    receipts_url: shareUrl(token),
    hash: current.hash,
    run_id: current.run_id,
    receipts: current.receipts,
    algorithm: current.algorithm
  }));

  // Tampered copies the verifier must catch.
  await save('tampered-index-hash.json', pretty(Object.assign({}, receipt, { answer_sha256: flipHex(receipt.answer_sha256, 0) })));
  const changed = receipt.excerpt.replace('default', 'only');
  if (changed === receipt.excerpt || plain(record.answer_text).includes(excerptCore(changed))) stop('the excerpt tamper did not change anything checkable');
  await save('tampered-index-excerpt.json', pretty(Object.assign({}, receipt, { excerpt: changed })));
  const wrong = flipHex(current.hash, 63);
  await save('tampered-decision-hash.json', pretty({ receipts_url: shareUrl(token), hash: wrong, run_id: current.run_id, receipts: current.receipts, algorithm: current.algorithm }));
  const refused = JSON.parse((await capture(shareVerifyUrl(token, wrong), 'decision-verify-wrong.json')).toString('utf8'));
  if (refused.matches !== false) stop('the app did not refuse the wrong hash');

  await save('manifest.json', pretty({
    note: 'Public data fetched by scripts/fetch-fixtures.mjs. The test fetch serves each URL (and byte range) from its file.',
    fetched_at: new Date().toISOString(),
    record_id: RECORD_ID,
    observation_id: OBSERVATION_ID,
    public_fix: PUBLIC_FIX,
    entries
  }));
  console.log('wrote ' + entries.length + ' fetched sources and the tampered copies to test/fixtures/');
}

main().catch(error => stop(error && error.stack || String(error)));
