#!/usr/bin/env node
// Builds two small files from the published Absence Index dataset (release 2026-09, DOI 10.5281/zenodo.22907695):
//
//   data/answers-2026-09.offsets.json  where each record sits in answers-2026-09.jsonl (byte offset and length),
//                                      so the verifier can read one record by HTTP Range instead of 9 MB.
//   data/release-2026-09.meta.json     the record's file names, sizes, SHA-256s, DOI and record URL.
//
// The script downloads the answers file from Zenodo (or reads a local copy given as the first argument),
// checks that its SHA-256 equals the pinned value and the line in the record's own SHA256SUMS.txt, and
// stops otherwise. Public reads only; no key of any kind.
//
// Usage: node scripts/build-offsets.mjs [path to a local answers-2026-09.jsonl]

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const RECORD_ID = '22907695';
const DOI = '10.5281/zenodo.' + RECORD_ID;
const RECORD_API = 'https://zenodo.org/api/records/' + RECORD_ID;
const RECORD_URL = 'https://zenodo.org/records/' + RECORD_ID;
const ANSWERS_FILE = 'answers-2026-09.jsonl';
const SUMS_FILE = 'SHA256SUMS.txt';
const PINNED_SHA256 = '221c94e1ebad2bc87d7cd20837fa670cc40b10dba6f68b75423dc8bee69697b3';
const ENGINES = ['ChatGPT', 'Claude', 'Perplexity', 'Google AI Overviews', 'Google AI Mode'];
const OFFSETS_TARGET = new URL('../data/answers-2026-09.offsets.json', import.meta.url);
const META_TARGET = new URL('../data/release-2026-09.meta.json', import.meta.url);

// Zenodo refuses the default Node.js client name, so every request says what it is.
const USER_AGENT = 'receipt-verifier/1.0.0 (+https://github.com/Broadcastwell/receipt-verifier)';

const fileUrl = name => RECORD_API + '/files/' + encodeURIComponent(name) + '/content';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function stop(message) {
  console.error('build-offsets: ' + message);
  process.exit(1);
}

async function get(url, as) {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) stop(url + ' answered ' + response.status);
  if (as === 'json') return response.json();
  if (as === 'text') return response.text();
  return Buffer.from(await response.arrayBuffer());
}

export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

// One row per line of the answers file, grouped by category, in file order:
// [question_id, engine index into "engines", repeat_index, byte offset, byte length without the newline].
export function buildLocator(bytes) {
  const categories = {};
  const seen = new Set();
  let offset = 0;
  let lines = 0;
  while (offset < bytes.length) {
    const end = bytes.indexOf(10, offset);
    if (end < 0) stop('the last line has no newline');
    const record = JSON.parse(bytes.subarray(offset, end).toString('utf8'));
    const engine = ENGINES.indexOf(record.engine);
    if (engine < 0) stop('unknown engine ' + record.engine);
    if (typeof record.question_id !== 'string' || !Number.isInteger(record.repeat_index)) stop('unexpected id types at byte ' + offset);
    const id = [record.category_id, record.question_id, record.engine, record.repeat_index].join('|');
    if (seen.has(id)) stop('duplicate record id ' + id);
    seen.add(id);
    (categories[record.category_id] ||= []).push([record.question_id, engine, record.repeat_index, offset, end - offset]);
    offset = end + 1;
    lines += 1;
  }
  return { lines, categories };
}

function renderLocator(locator, bytes) {
  const head = {
    file: ANSWERS_FILE,
    url: fileUrl(ANSWERS_FILE),
    sha256: PINNED_SHA256,
    bytes: bytes.length,
    lines: locator.lines,
    doi: DOI,
    row: ['question_id', 'engine', 'repeat_index', 'offset', 'length'],
    engines: ENGINES
  };
  const parts = Object.entries(head).map(([key, value]) => '  ' + JSON.stringify(key) + ': ' + JSON.stringify(value));
  const categories = Object.keys(locator.categories).sort().map(category => {
    const rows = locator.categories[category].map(row => '      ' + JSON.stringify(row)).join(',\n');
    return '    ' + JSON.stringify(category) + ': [\n' + rows + '\n    ]';
  });
  return '{\n' + parts.join(',\n') + ',\n  "categories": {\n' + categories.join(',\n') + '\n  }\n}\n';
}

function buildMeta(record, sums) {
  const files = record.files.map(file => {
    const sha = sums.get(file.key);
    if (!sha && file.key !== SUMS_FILE) stop('no SHA256SUMS.txt line for ' + file.key);
    return { name: file.key, size: file.size, sha256: sha || null, md5: String(file.checksum || '').replace(/^md5:/, '') || null, url: fileUrl(file.key) };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return {
    title: record.metadata.title,
    release_id: '2026-09',
    publication_date: record.metadata.publication_date,
    doi: record.doi,
    doi_url: 'https://doi.org/' + record.doi,
    record_url: RECORD_URL,
    record_api: RECORD_API,
    license: 'CC BY 4.0',
    sums_file: SUMS_FILE,
    files
  };
}

async function main() {
  const local = process.argv[2];
  const record = await get(RECORD_API, 'json');
  if (record.doi !== DOI) stop('the Zenodo record carries DOI ' + record.doi + ', not ' + DOI);
  const sums = parseSums(await get(fileUrl(SUMS_FILE), 'text'));
  if (sums.get(ANSWERS_FILE) !== PINNED_SHA256) stop('SHA256SUMS.txt lists ' + sums.get(ANSWERS_FILE) + ' for ' + ANSWERS_FILE + ', not the pinned ' + PINNED_SHA256);
  const bytes = local ? await readFile(local) : await get(fileUrl(ANSWERS_FILE));
  const digest = sha256(bytes);
  if (digest !== PINNED_SHA256) stop(ANSWERS_FILE + ' hashes to ' + digest + ', not the pinned ' + PINNED_SHA256);
  const listed = record.files.find(file => file.key === ANSWERS_FILE);
  if (!listed || listed.size !== bytes.length) stop('the Zenodo record lists a different size for ' + ANSWERS_FILE);
  const locator = buildLocator(bytes);
  await writeFile(OFFSETS_TARGET, renderLocator(locator, bytes));
  await writeFile(META_TARGET, JSON.stringify(buildMeta(record, sums), null, 2) + '\n');
  console.log('answers file SHA-256 ' + digest + ' (equal to the pinned value and SHA256SUMS.txt)');
  console.log('wrote data/answers-2026-09.offsets.json: ' + locator.lines + ' records in ' + Object.keys(locator.categories).length + ' categories');
  console.log('wrote data/release-2026-09.meta.json: ' + record.files.length + ' files');
}

if (process.argv[1] && process.argv[1].endsWith('build-offsets.mjs')) {
  main().catch(error => stop(error && error.stack || String(error)));
}
