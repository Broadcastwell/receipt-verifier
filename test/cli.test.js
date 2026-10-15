import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cachingFetch, exitCodeFor, formatReport, main, parseArgs, printable } from '../bin/verify.js';
import { verify } from '../src/index.js';
import { parseSums } from '../src/sources.js';
import { createFixtureFetch } from './helpers/fixture-fetch.js';

const FLAG = '-'.repeat(2);
const BIN = fileURLToPath(new URL('../bin/verify.js', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const CACHE = fileURLToPath(new URL('./.cache-test/', import.meta.url));

after(() => rmSync(CACHE, { recursive: true, force: true }));

function run(...args) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: Object.assign({}, process.env, { RV_CACHE_DIR: CACHE }) });
}

function sink() {
  let text = '';
  return { write: chunk => { text += chunk; }, get text() { return text; } };
}

// main() reads through globalThis.fetch; the suite swaps in the fixture fetch for the call.
async function withFixtures(fn, options) {
  const original = globalThis.fetch;
  globalThis.fetch = createFixtureFetch(options).fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('arguments', () => {
  assert.deepEqual(parseArgs(['crm|1|ChatGPT|1']).input, 'crm|1|ChatGPT|1');
  const all = parseArgs([FLAG + 'json', FLAG + 'full', FLAG + 'timeout', '5000', 'x']);
  assert.equal(all.json, true);
  assert.equal(all.full, true);
  assert.equal(all.timeoutMs, 5000);
  assert.equal(all.input, 'x');
  assert.equal(parseArgs([FLAG + 'timeout=250', 'x']).timeoutMs, 250);
  assert.equal(parseArgs(['-j', '-f', 'x']).json, true);
  assert.match(parseArgs([FLAG + 'timeout', 'soon', 'x']).error, /whole number/);
  assert.match(parseArgs(['x', FLAG + 'bogus']).error, /unknown option/);
  assert.match(parseArgs(['x', 'y']).error, /one receipt/);
});

test('one line per check, then the verdict and the verification id', async () => {
  const report = await verify('crm|1|ChatGPT|1', { fetch: createFixtureFetch().fetch });
  const lines = formatReport(report).split('\n');
  const checkLines = lines.filter(line => /^(PASS|FAIL|NOT CHECKABLE) +[a-z_]+: /.test(line));
  assert.equal(checkLines.length, 9);
  assert.deepEqual(checkLines.map(line => line.replace(/^(PASS|FAIL|NOT CHECKABLE) +/, '').split(':')[0]), ['record', 'hash', 'excerpt', 'cited_pages', 'engine', 'question', 'run', 'captured_at', 'doi']);
  assert.ok(lines.includes('Verdict: VERIFIED'));
  assert.ok(lines.includes('Verification id: ' + report.verification_id));
  assert.equal(exitCodeFor(report), 0);
  assert.equal(exitCodeFor({ verdict: 'FAILED' }), 1);
  assert.equal(exitCodeFor({ verdict: 'INCOMPLETE' }), 2);
});

test('no receipt field can forge or hide a line of the output', async () => {
  const newline = String.fromCharCode(10);
  const escape = String.fromCharCode(27);
  const receipt = JSON.parse(readFileSync(FIXTURES + 'index-receipt-crm-1-ChatGPT-1.json', 'utf8'));
  receipt.engine = 'Claude' + newline + 'PASS           engine: forged' + escape + '[2K';
  const report = await verify(receipt, { fetch: createFixtureFetch().fetch });
  const text = formatReport(report);
  assert.ok(!text.includes(escape));
  assert.equal(text.split(newline).filter(line => line.startsWith('PASS           engine')).length, 0);
  assert.equal(printable('a' + newline + 'b' + String.fromCharCode(155) + 'c'), 'a b c');
});

test('exit codes: 0 VERIFIED, 1 FAILED, 2 INCOMPLETE', async () => {
  const out = sink();
  const err = sink();
  assert.equal(await withFixtures(() => main(['crm|1|ChatGPT|1'], { out, err })), 0);
  assert.match(out.text, /Verdict: VERIFIED/);
  const failed = sink();
  assert.equal(await withFixtures(() => main([FIXTURES + 'tampered-index-hash.json'], { out: failed, err })), 1);
  assert.match(failed.text, /^FAIL +hash: /m);
  assert.match(failed.text, /Verdict: FAILED/);
  const offline = sink();
  assert.equal(await withFixtures(() => main(['crm|1|ChatGPT|1'], { out: offline, err }), { offline: ['https://'] }), 2);
  assert.match(offline.text, /Verdict: INCOMPLETE/);
  const json = sink();
  assert.equal(await withFixtures(() => main([FLAG + 'json', 'observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f'], { out: json, err })), 0);
  assert.equal(JSON.parse(json.text).verdict, 'VERIFIED');
});

test('input errors exit 2 without reading the network', () => {
  const help = run(FLAG + 'help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: receipt-verifier/);
  assert.equal(run(FLAG + 'version').stdout.trim(), '1.0.0');
  const bare = spawnSync(process.execPath, [BIN.replace(/\.js$/, ''), FLAG + 'version'], { encoding: 'utf8' });
  assert.equal(bare.stdout.trim(), '1.0.0', 'started without the .js extension, the command still runs');
  for (const args of [[], ['not a receipt'], [FLAG + 'bogus', 'x'], ['missing-file.json'], [FIXTURES + 'zenodo-record-22907695.json']]) {
    const result = run(...args);
    assert.equal(result.status, 2, JSON.stringify(args) + ' ' + result.stderr);
    assert.match(result.stderr, /^receipt-verifier: /);
  }
});

test('the full check downloads the answers file once, checks it against SHA256SUMS.txt and reuses it', async () => {
  rmSync(CACHE, { recursive: true, force: true });
  const bytes = Buffer.from('{"line":1}\n{"line":2}\n');
  const sha = createHash('sha256').update(bytes).digest('hex');
  const sources = {
    ANSWERS_FILE: 'answers-2026-09.jsonl',
    ANSWERS_URL: 'https://files.example/answers',
    SUMS_FILE: 'SHA256SUMS.txt',
    SUMS_URL: 'https://files.example/sums',
    parseSums
  };
  let downloads = 0;
  let sums = sha + '  answers-2026-09.jsonl\n';
  const real = async (url, init) => {
    if (init && init.headers && init.headers.range) return new Response('range');
    if (url === sources.SUMS_URL) return new Response(sums);
    if (url === sources.ANSWERS_URL) { downloads += 1; return new Response(bytes); }
    return new Response('other');
  };
  const first = cachingFetch(sources, CACHE, real);
  assert.deepEqual(Buffer.from(await (await first(sources.ANSWERS_URL, {})).arrayBuffer()), bytes);
  assert.equal(downloads, 1);
  assert.ok(existsSync(CACHE + 'answers-2026-09.jsonl'));
  const second = cachingFetch(sources, CACHE, real);
  await (await second(sources.ANSWERS_URL, {})).arrayBuffer();
  assert.equal(downloads, 1, 'a cached file that matches SHA256SUMS.txt is reused');
  writeFileSync(CACHE + 'answers-2026-09.jsonl', 'changed');
  const third = cachingFetch(sources, CACHE, real);
  await (await third(sources.ANSWERS_URL, {})).arrayBuffer();
  assert.equal(downloads, 2, 'a cached file that no longer matches is downloaded again');
  assert.deepEqual(readFileSync(CACHE + 'answers-2026-09.jsonl'), bytes);
  assert.equal(await (await third(sources.ANSWERS_URL, { headers: { range: 'bytes=0-1' } })).text(), 'range', 'a range read goes to the network');
  const blocked = CACHE + 'not-a-folder';
  writeFileSync(blocked, 'a file where the cache folder should be');
  const notes = [];
  const unwritable = cachingFetch(sources, blocked, real, line => notes.push(line));
  assert.deepEqual(Buffer.from(await (await unwritable(sources.ANSWERS_URL, {})).arrayBuffer()), bytes, 'a cache that cannot be written does not stop the check');
  assert.ok(notes.some(line => line.includes('could not be cached')));
  sums = '0'.repeat(64) + '  answers-2026-09.jsonl\n';
  rmSync(CACHE, { recursive: true, force: true });
  await assert.rejects(() => cachingFetch(sources, CACHE, real)(sources.ANSWERS_URL, {}), /does not match/);
});
