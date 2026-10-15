import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { VERSION, verify } from '../src/index.js';
import { CHECK_IDS, buildReport, canonicalJson, sha256Hex, verdictOf } from '../src/report.js';
import { createFixtureFetch } from './helpers/fixture-fetch.js';

const checks = status => Object.fromEntries(CHECK_IDS.map(id => [id, { status, reason: 'r' }]));

test('canonical JSON sorts keys at every depth and has no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { f: 1, e: 2 }], c: 'x y' } }), '{"a":{"c":"x y","d":[3,{"e":2,"f":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: null }), '{"b":null}');
  assert.equal(canonicalJson('caf' + String.fromCharCode(0xe9)), JSON.stringify('caf' + String.fromCharCode(0xe9)));
});

test('SHA-256 of a known value', async () => {
  assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256Hex(new Uint8Array([97, 98, 99])), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('the verdict rule', () => {
  const list = (record, hash, others = 'PASS') => CHECK_IDS.map(id => ({ id, status: id === 'record' ? record : id === 'hash' ? hash : others }));
  assert.equal(verdictOf(list('PASS', 'PASS')), 'VERIFIED');
  assert.equal(verdictOf(list('PASS', 'PASS', 'NOT CHECKABLE')), 'VERIFIED');
  assert.equal(verdictOf(list('PASS', 'NOT CHECKABLE')), 'INCOMPLETE');
  assert.equal(verdictOf(list('NOT CHECKABLE', 'PASS')), 'INCOMPLETE');
  assert.equal(verdictOf(list('PASS', 'PASS', 'FAIL')), 'FAILED');
  assert.equal(verdictOf(list('FAIL', 'NOT CHECKABLE', 'NOT CHECKABLE')), 'FAILED');
});

test('the verification id leaves out the time and the reasons, and keeps everything else', async () => {
  const base = { kind: 'index', subject: 's', receipt: { a: 1 }, receiptSource: 'given', checks: checks('PASS'), dataset: { doi: 'd' }, sources: [] };
  const one = await buildReport(base);
  const two = await buildReport(Object.assign({}, base, { checks: Object.fromEntries(CHECK_IDS.map(id => [id, { status: 'PASS', reason: 'other words' }])), sources: ['https://x'] }));
  assert.equal(one.verification_id, two.verification_id);
  const changed = await buildReport(Object.assign({}, base, { receipt: { a: 2 } }));
  assert.notEqual(one.verification_id, changed.verification_id);
  const statusChanged = await buildReport(Object.assign({}, base, { checks: Object.assign(checks('PASS'), { doi: { status: 'NOT CHECKABLE', reason: 'r' } }) }));
  assert.notEqual(one.verification_id, statusChanged.verification_id);
  const identity = {
    verifier: { name: 'receipt-verifier', version: VERSION },
    kind: 'index',
    receipt: { a: 1 },
    checks: CHECK_IDS.map(id => ({ id, status: 'PASS' })),
    verdict: 'VERIFIED',
    dataset: { doi: 'd' }
  };
  assert.equal(one.verification_id, await sha256Hex(canonicalJson(identity)), 'the id is SHA-256 of the documented canonical JSON');
  assert.match(one.checked_at, /^\d{4}-\d{2}-\d{2}T/);
  await assert.rejects(() => buildReport(Object.assign({}, base, { checks: { record: { status: 'PASS', reason: 'r' } } })));
});

test('VERSION equals the package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(VERSION, pkg.version);
  assert.equal(VERSION, '1.0.0');
});

test('a report lists the sources it read and the dataset it checked against', async () => {
  const report = await verify('crm|1|ChatGPT|1', { fetch: createFixtureFetch().fetch });
  assert.deepEqual(report.dataset, { doi: '10.5281/zenodo.22907695', release: '2026-09', file: 'answers-2026-09.jsonl', sha256: '221c94e1ebad2bc87d7cd20837fa670cc40b10dba6f68b75423dc8bee69697b3' });
  assert.deepEqual(report.verifier, { name: 'receipt-verifier', version: '1.0.0' });
  assert.ok(report.sources.length >= 3);
  for (const source of report.sources) assert.match(source, /^https:\/\/(app\.broadcastwell\.com|zenodo\.org|doi\.org)\//);
});
