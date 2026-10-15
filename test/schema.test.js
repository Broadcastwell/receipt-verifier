import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verify } from '../src/index.js';
import { createFixtureFetch, fixtureJson } from './helpers/fixture-fetch.js';

const load = name => JSON.parse(readFileSync(new URL('../schema/' + name, import.meta.url), 'utf8'));
const RECEIPT_SCHEMA = load('receipt.schema.json');
const REPORT_SCHEMA = load('report.schema.json');

// A small validator for the JSON Schema 2020-12 keywords these two schemas use. It returns a list of
// problems; an empty list means the value is valid.
function validate(schema, value, root = schema, path = '$') {
  if (schema === true) return [];
  if (schema === false) return [path + ': no value is allowed here'];
  const problems = [];
  const add = message => problems.push(path + ': ' + message);
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], root);
    problems.push(...validate(target, value, root, path));
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(branch => validate(branch, value, root, path).length === 0).length;
    if (matches !== 1) add('matches ' + matches + ' of the oneOf branches, not exactly one');
  }
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(value)) add('is not ' + JSON.stringify(schema.const));
  if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) add('is not one of ' + JSON.stringify(schema.enum));
  if (schema.type) {
    const kind = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
    const allowed = [].concat(schema.type);
    if (!allowed.includes(kind) && !(kind === 'integer' && allowed.includes('number'))) {
      add('is ' + kind + ', not ' + allowed.join(' or '));
      return problems;
    }
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) add('is shorter than ' + schema.minLength);
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) add('does not match ' + schema.pattern);
    if (schema.format === 'date-time' && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) add('is not a date-time');
    if (schema.format === 'uri') {
      try { new URL(value); } catch (error) { add('is not a URI'); }
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) add('is below ' + schema.minimum);
    if (schema.maximum !== undefined && value > schema.maximum) add('is above ' + schema.maximum);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add('has fewer than ' + schema.minItems + ' items');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) add('has more than ' + schema.maxItems + ' items');
    const prefix = schema.prefixItems || [];
    value.forEach((item, index) => {
      const itemSchema = index < prefix.length ? prefix[index] : schema.items;
      if (itemSchema !== undefined) problems.push(...validate(itemSchema, item, root, path + '[' + index + ']'));
    });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!(key in value)) add('lacks ' + key);
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (properties[key]) problems.push(...validate(properties[key], item, root, path + '.' + key));
      else if (schema.additionalProperties === false) add('has an unexpected field ' + key);
    }
  }
  return problems;
}

test('both schemas declare JSON Schema 2020-12', () => {
  for (const schema of [RECEIPT_SCHEMA, REPORT_SCHEMA]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.match(schema.$id, /^https:\/\/broadcastwell\.github\.io\/receipt-verifier\/schema\//);
  }
});

test('the real receipts of all three kinds fit the receipt schema, each in exactly one branch', () => {
  const receipts = [
    fixtureJson('index-receipt-crm-1-ChatGPT-1.json'),
    fixtureJson('sample-receipt-observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f.json'),
    fixtureJson('decision-receipt-public-fix.json'),
    fixtureJson('tampered-index-hash.json'),
    fixtureJson('tampered-decision-hash.json')
  ];
  for (const receipt of receipts) assert.deepEqual(validate(RECEIPT_SCHEMA, receipt), [], JSON.stringify(receipt).slice(0, 80));
  for (const name of ['index', 'sample', 'decision']) {
    const branch = RECEIPT_SCHEMA.$defs[name];
    assert.ok(branch.required.length > 0, name);
  }
});

test('things that are not receipts do not fit the receipt schema', () => {
  const index = fixtureJson('index-receipt-crm-1-ChatGPT-1.json');
  assert.notDeepEqual(validate(RECEIPT_SCHEMA, {}), []);
  assert.notDeepEqual(validate(RECEIPT_SCHEMA, Object.assign({}, index, { engine: 'Another engine' })), []);
  assert.notDeepEqual(validate(RECEIPT_SCHEMA, Object.assign({}, index, { answer_sha256: 'xyz' })), []);
  assert.notDeepEqual(validate(RECEIPT_SCHEMA, Object.assign({}, index, { run: 4 })), []);
  assert.notDeepEqual(validate(RECEIPT_SCHEMA, { receipts_url: 'https://example.com/s/' + 'a'.repeat(64), hash: 'a'.repeat(64) }), []);
});

test('reports of every kind and verdict fit the report schema', async () => {
  const inputs = [
    'crm|1|ChatGPT|1',
    'observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f',
    'https://app.broadcastwell.com/public-fix/broadcastwell',
    fixtureJson('tampered-index-hash.json'),
    fixtureJson('tampered-decision-hash.json'),
    'crm|11|ChatGPT|1'
  ];
  const verdicts = new Set();
  for (const input of inputs) {
    const report = await verify(input, { fetch: createFixtureFetch().fetch });
    verdicts.add(report.verdict);
    assert.deepEqual(validate(REPORT_SCHEMA, report), [], JSON.stringify(input));
  }
  const offline = await verify('crm|1|ChatGPT|1', { fetch: createFixtureFetch({ offline: ['https://'] }).fetch });
  verdicts.add(offline.verdict);
  assert.deepEqual(validate(REPORT_SCHEMA, offline), []);
  assert.deepEqual([...verdicts].sort(), ['FAILED', 'INCOMPLETE', 'VERIFIED']);
});
