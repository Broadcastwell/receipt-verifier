// A fetch that serves the real public data in test/fixtures/ (fetched once by scripts/fetch-fixtures.mjs)
// so the suite runs offline. A URL with no fixture fails the way a network failure does.

import { readFileSync } from 'node:fs';

const DIR = new URL('../fixtures/', import.meta.url);

export function fixtureBytes(name) {
  return readFileSync(new URL(name, DIR));
}

export function fixtureText(name) {
  return fixtureBytes(name).toString('utf8');
}

export function fixtureJson(name) {
  return JSON.parse(fixtureText(name));
}

export const MANIFEST = fixtureJson('manifest.json');

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find(item => item.toLowerCase() === name);
  return key ? headers[key] : null;
}

// overrides: { [url]: (init) => Response | Promise<Response> }  answers for one URL
// offline:   [url prefix]                                         prefixes that fail like a network error
export function createFixtureFetch({ overrides = {}, offline = [] } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const range = headerOf(init.headers, 'range');
    calls.push({ url, range, redirect: init.redirect || 'follow' });
    if (offline.some(prefix => url.startsWith(prefix))) throw new TypeError('fetch failed');
    if (typeof overrides[url] === 'function') return overrides[url](init);
    const entry = MANIFEST.entries.find(item => item.url === url && (item.range || null) === (range || null));
    if (!entry) throw new TypeError('fetch failed: no fixture for ' + url + (range ? ' (' + range + ')' : ''));
    if (entry.location) return new Response(null, { status: entry.status, headers: { location: entry.location } });
    return new Response(fixtureBytes(entry.file), {
      status: entry.status,
      headers: { 'content-type': entry.content_type || 'application/octet-stream' }
    });
  };
  return { fetch, calls };
}

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

export function statusOf(report, id) {
  const check = report.checks.find(item => item.id === id);
  return check ? check.status : undefined;
}

export function reasonOf(report, id) {
  const check = report.checks.find(item => item.id === id);
  return check ? check.reason : undefined;
}
