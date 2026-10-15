import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ANSWERS_FILE, ANSWERS_URL, DOI, LOCATOR, META, locate } from '../src/sources.js';
import { MANIFEST, fixtureBytes } from './helpers/fixture-fetch.js';

const PINNED = '221c94e1ebad2bc87d7cd20837fa670cc40b10dba6f68b75423dc8bee69697b3';

test('the offsets locator round-trips against the fixture line', () => {
  const at = locate(LOCATOR, { category: 'crm', question: '1', engine: 'ChatGPT', run: 1 });
  const line = fixtureBytes('answers-crm-1-ChatGPT-1.jsonl');
  assert.equal(line.length, at.length, 'the located length is the length of the published line');
  const entry = MANIFEST.entries.find(item => item.url === ANSWERS_URL && item.range);
  assert.equal(entry.range, 'bytes=' + at.offset + '-' + (at.offset + at.length - 1), 'the fixture was read at the located range');
  assert.equal(entry.status, 206);
  const record = JSON.parse(line.toString('utf8'));
  assert.deepEqual([record.category_id, record.question_id, record.engine, record.repeat_index], ['crm', '1', 'ChatGPT', 1]);
});

test('the locator covers the whole pinned answers file, line after line', () => {
  assert.equal(LOCATOR.file, ANSWERS_FILE);
  assert.equal(LOCATOR.sha256, PINNED);
  assert.equal(LOCATOR.doi, DOI);
  const rows = Object.values(LOCATOR.categories).flat().sort((a, b) => a[3] - b[3]);
  assert.equal(rows.length, LOCATOR.lines);
  assert.equal(rows.length, 2250);
  let next = 0;
  for (const row of rows) {
    assert.equal(row[3], next, 'each line starts right after the previous newline');
    next = row[3] + row[4] + 1;
  }
  assert.equal(next, LOCATOR.bytes, 'the last newline ends the file');
  const ids = new Set();
  for (const [category, list] of Object.entries(LOCATOR.categories)) {
    for (const row of list) ids.add([category, row[0], LOCATOR.engines[row[1]], row[2]].join('|'));
  }
  assert.equal(ids.size, 2250, 'every record id is unique');
  assert.equal(Object.keys(LOCATOR.categories).length, 14);
});

test('locate() answers null for a record the file does not hold', () => {
  assert.equal(locate(LOCATOR, { category: 'crm', question: '11', engine: 'ChatGPT', run: 1 }), null);
  assert.equal(locate(LOCATOR, { category: 'nothing', question: '1', engine: 'ChatGPT', run: 1 }), null);
  assert.equal(locate(LOCATOR, { category: 'crm', question: '1', engine: 'Another', run: 1 }), null);
});

test('the release meta names the dataset and agrees with the locator and SHA256SUMS.txt', () => {
  assert.equal(META.doi, DOI);
  assert.equal(META.record_url, 'https://zenodo.org/records/22907695');
  assert.equal(META.license, 'CC BY 4.0');
  const answers = META.files.find(file => file.name === ANSWERS_FILE);
  assert.equal(answers.sha256, PINNED);
  assert.equal(answers.size, LOCATOR.bytes);
  const sums = readFileSync(new URL('./fixtures/zenodo-SHA256SUMS.txt', import.meta.url), 'utf8');
  for (const file of META.files.filter(item => item.sha256)) {
    assert.ok(sums.includes(file.sha256 + '  ' + file.name), file.name);
  }
  assert.ok(!JSON.stringify(META).includes('"questions"'), 'no question texts in the meta file');
});
