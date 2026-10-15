// The repository's own rules, checked on every run: the library stays portable and plain, the copy keeps
// to its rules, nothing secret or internal is in the tree, and every file except the quoted fixtures is
// plain ASCII.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TWO_HYPHENS = '-'.repeat(2);
const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === '.cache-test') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

const FILES = walk(ROOT).map(path => ({ path, rel: relative(ROOT, path).split(sep).join('/') }));
const SOURCE = FILES.filter(file => file.rel.startsWith('src/'));
const OWN = FILES.filter(file => !file.rel.startsWith('test/fixtures/'));
const text = file => readFileSync(file.path, 'utf8');

test('src/ is ASCII, has no two-hyphen sequence and none of the banned words', () => {
  const banned = ['guarantee', 'gemini', 'studio', 'startup', 'boutique', 'solo', 'best in', 'rank #'];
  assert.ok(SOURCE.length >= 6);
  for (const file of SOURCE) {
    const bytes = readFileSync(file.path);
    for (const byte of bytes) assert.ok(byte === 9 || byte === 10 || (byte >= 32 && byte <= 126), file.rel + ' has byte ' + byte);
    const body = bytes.toString('utf8');
    assert.ok(!body.includes(TWO_HYPHENS), file.rel + ' has two hyphens in a row');
    for (const word of banned) assert.ok(!body.toLowerCase().includes(word), file.rel + ' has ' + word);
  }
});

test('src/ uses only what Node 20, browsers and Workers all have', () => {
  for (const file of SOURCE) {
    const body = text(file);
    assert.ok(!/from\s+['"]node:/.test(body) && !/import\(\s*['"]node:/.test(body), file.rel + ' imports a node: module');
    assert.ok(!/\bprocess\b/.test(body), file.rel + ' uses process');
    assert.ok(!/\bBuffer\b/.test(body), file.rel + ' uses Buffer');
    assert.ok(!/\brequire\s*\(/.test(body), file.rel + ' uses require');
    for (const match of body.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(match[1].startsWith('./') || match[1].startsWith('../data/'), file.rel + ' imports ' + match[1]);
    }
  }
});

test('every file except the quoted fixtures is ASCII with no control bytes but tab and newline', () => {
  for (const file of OWN) {
    const bytes = readFileSync(file.path);
    const bad = bytes.findIndex(byte => !(byte === 9 || byte === 10 || (byte >= 32 && byte <= 126)));
    assert.equal(bad, -1, file.rel + ' has byte ' + bytes[bad] + ' at ' + bad);
  }
});

test('nothing in the tree looks like a secret', () => {
  const patterns = [
    new RegExp('b' + 'wp_[A-Za-z0-9_]{4,}'),
    new RegExp('s' + 'k_(live|test)_[A-Za-z0-9]{8,}'),
    new RegExp('g' + 'hp_[A-Za-z0-9]{20,}'),
    new RegExp('A' + 'KIA[0-9A-Z]{16}'),
    new RegExp('-{5}BEGIN [A-Z ]*' + 'PRIVATE ' + 'KEY'),
    new RegExp('x' + 'ox[abprs]-[A-Za-z0-9-]{10,}'),
    new RegExp('eyJ[A-Za-z0-9_-]{20,}' + '[.]eyJ[A-Za-z0-9_-]{20,}')
  ];
  for (const file of FILES) {
    const body = text(file);
    for (const pattern of patterns) assert.ok(!pattern.test(body), file.rel + ' matches ' + pattern.source.slice(0, 6));
  }
});

test('no engine code, internal names, account routes or client data outside the fixtures', () => {
  const forbidden = ['functions/' + 'lib', 'build-index-' + 'receipts', 'receipts-2026-09' + '.js', 'public-' + 'data.js', 'decision' + '.js', 'receipt' + 'Hash', 'n' + '8n', 'wran' + 'gler', '.dev' + '.vars', '/api/v1/' + 'accounts', 'exchange_' + 'receipt', 'model_' + 'string'];
  for (const file of OWN) {
    const body = text(file);
    for (const word of forbidden) assert.ok(!body.includes(word), file.rel + ' has ' + word);
  }
});

test('the copy keeps its rules: no dashes, no double hyphens in prose, no Gemini, no prices, no promises', () => {
  const copy = OWN.filter(file => ['README.md', 'index.html', 'CITATION.cff'].includes(file.rel) || file.rel.startsWith('web/') || file.rel === 'bin/verify.js');
  assert.ok(copy.length >= 5);
  for (const file of copy) {
    const body = text(file);
    assert.ok(!body.includes(EM_DASH) && !body.includes(EN_DASH), file.rel + ' has a dash');
    assert.ok(!/gemini/i.test(body), file.rel + ' names Gemini');
    assert.ok(!/\$[0-9]/.test(body), file.rel + ' has a price');
    assert.ok(!/guarantee/i.test(body), file.rel + ' promises an outcome');
    if (file.rel.startsWith('web/') || file.rel === 'index.html' || file.rel === 'bin/verify.js') {
      assert.ok(!body.includes(TWO_HYPHENS), file.rel + ' has two hyphens in a row');
    }
  }
  const readme = text(FILES.find(file => file.rel === 'README.md'));
  let fenced = false;
  for (const line of readme.split('\n')) {
    if (line.startsWith('```')) { fenced = !fenced; continue; }
    if (fenced || line === '<!-- DOI badge: added after the v1.0.0 release is archived -->') continue;
    assert.ok(!line.includes(TWO_HYPHENS), 'README prose has two hyphens: ' + line);
  }
  assert.ok(readme.includes('\n<!-- DOI badge: added after the v1.0.0 release is archived -->\n'));
  assert.ok(readme.includes('This repository contains no engine code: no prompts, no question bank, no measurement or classification logic.'));
  for (const engine of ['ChatGPT', 'Claude', 'Perplexity', 'Google AI Overviews', 'Google AI Mode']) assert.ok(readme.includes(engine), engine);
});

test('the package has no dependencies', () => {
  const pkg = JSON.parse(text(FILES.find(file => file.rel === 'package.json')));
  assert.deepEqual(Object.keys(pkg.dependencies || {}), []);
  assert.equal(pkg.devDependencies, undefined);
  assert.equal(pkg.license, 'MIT');
  assert.equal(pkg.bin['receipt-verifier'], 'bin/verify.js');
});
