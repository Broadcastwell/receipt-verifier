// The public sources the verifier reads, and small fetch helpers with timeouts.
// Every address is built here from fixed parts and checked identifiers; no address from the input is
// fetched as given. Nothing here needs a key, and nothing here calls an answer engine.

import LOCATOR from '../data/answers-2026-09.offsets.json' with { type: 'json' };
import META from '../data/release-2026-09.meta.json' with { type: 'json' };
import { NAME, VERSION } from './report.js';

export { LOCATOR, META };

export const APP_ORIGIN = 'https://app.broadcastwell.com';
export const ZENODO_RECORD_ID = '22907695';
export const DOI = '10.5281/zenodo.22907695';
export const DOI_URL = 'https://doi.org/' + DOI;
export const ZENODO_RECORD_URL = 'https://zenodo.org/records/' + ZENODO_RECORD_ID;
export const ZENODO_API_RECORD = 'https://zenodo.org/api/records/' + ZENODO_RECORD_ID;
export const RELEASE_ID = '2026-09';
export const ANSWERS_FILE = 'answers-2026-09.jsonl';
export const RELEASE_FILE = 'release-2026-09.json';
export const CONTROLS_FILE = 'control-questions.json';
export const SUMS_FILE = 'SHA256SUMS.txt';
export const SAMPLE_EXPORT_URL = APP_ORIGIN + '/api/export/kalvenor-monitor.json';
export const NETWORK_REASON = 'the source could not be read from here; try the command line';
export const DEFAULT_TIMEOUT_MS = 15000;
export const FULL_TIMEOUT_MS = 180000;

// Zenodo refuses the default Node.js client name. A page in a browser cannot set this header, and does
// not need to, so it is sent only outside a browser window.
const USER_AGENT = NAME + '/' + VERSION + ' (+https://github.com/Broadcastwell/receipt-verifier)';

export function zenodoFileUrl(name) {
  return ZENODO_API_RECORD + '/files/' + encodeURIComponent(name) + '/content';
}
export const ANSWERS_URL = zenodoFileUrl(ANSWERS_FILE);
export const SUMS_URL = zenodoFileUrl(SUMS_FILE);

export function categoryUrl(categoryId) {
  return APP_ORIGIN + '/api/v1/index/categories/' + encodeURIComponent(categoryId);
}
export function publicFixUrl(slug) {
  return APP_ORIGIN + '/api/v1/public-fix/' + encodeURIComponent(slug);
}
export function shareUrl(token) {
  return APP_ORIGIN + '/s/' + token;
}
export function shareVerifyUrl(token, hash) {
  return shareUrl(token) + '?verify=' + (hash || '');
}

export function createContext(options = {}) {
  if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new TypeError('options.fetch is a function');
  if (options.fetch === undefined && typeof globalThis.fetch !== 'function') throw new TypeError('no fetch is available; pass options.fetch');
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  // Browsers and Workers refuse a fetch called as a method of another object ("Illegal invocation"),
  // so the global fetch is always called on globalThis and an injected one as a plain function.
  const injected = options.fetch;
  const fetchImpl = injected ? (url, init) => injected(url, init) : (url, init) => globalThis.fetch(url, init);
  return { fetch: fetchImpl, timeoutMs, sources: [], memo: new Map() };
}

function inBrowser() {
  if (typeof window !== 'undefined') return true;
  const agent = typeof navigator !== 'undefined' && navigator ? navigator.userAgent : '';
  return typeof agent === 'string' && agent.startsWith('Mozilla/');
}

function requestHeaders(extra) {
  const headers = Object.assign({}, extra);
  if (!inBrowser()) headers['user-agent'] = USER_AGENT;
  return headers;
}

function note(ctx, url) {
  if (!ctx.sources.includes(url)) ctx.sources.push(url);
}

// Runs one request and reads its body under one timeout. Never throws: the result says what happened.
//   { state: 'ok', status, body, headers, url }   any 2xx answer
//   { state: 'http', status }                       an answer outside 2xx
//   { state: 'network', error }                     no answer could be read (offline, CORS, timeout)
async function run(ctx, url, init, read, timeoutMs) {
  note(ctx, url);
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      if (controller) controller.abort();
      resolve({ state: 'network', error: 'timed out after ' + timeoutMs + ' ms' });
    }, timeoutMs);
  });
  const attempt = (async () => {
    try {
      const response = await ctx.fetch(url, Object.assign({}, init, controller ? { signal: controller.signal } : {}));
      if (response.status < 200 || response.status > 299) {
        if (response.body && typeof response.body.cancel === 'function') {
          try { await response.body.cancel(); } catch (ignored) { /* the status is what matters */ }
        }
        return { state: 'http', status: response.status, headers: response.headers, type: response.type };
      }
      const body = await read(response);
      return { state: 'ok', status: response.status, body, headers: response.headers, url: response.url };
    } catch (error) {
      return { state: 'network', error: String(error && error.message ? error.message : error) };
    }
  })();
  try {
    return await Promise.race([attempt, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function memo(ctx, key, make) {
  if (!ctx.memo.has(key)) ctx.memo.set(key, make());
  return ctx.memo.get(key);
}

export function getText(ctx, url) {
  return memo(ctx, 'text ' + url, () => run(ctx, url, { headers: requestHeaders() }, r => r.text(), ctx.timeoutMs));
}

export async function getJson(ctx, url) {
  const result = await getText(ctx, url);
  if (result.state !== 'ok') return result;
  try {
    return Object.assign({}, result, { body: JSON.parse(result.body) });
  } catch (error) {
    return { state: 'parse', error: 'the answer is not JSON' };
  }
}

// The whole body as bytes; used only for the full check, which reads the 9 MB answers file once.
export function getBytes(ctx, url, timeoutMs) {
  return memo(ctx, 'bytes ' + url, () => run(ctx, url, { headers: requestHeaders() }, async r => new Uint8Array(await r.arrayBuffer()), timeoutMs || ctx.timeoutMs));
}

// One byte range [offset, offset + length). A server that ignores Range and sends the whole file still
// works: the range is cut from what arrived.
export async function getRange(ctx, url, offset, length) {
  const range = 'bytes=' + offset + '-' + (offset + length - 1);
  const result = await memo(ctx, 'range ' + range + ' ' + url, () => run(ctx, url, { headers: requestHeaders({ range }) }, async r => new Uint8Array(await r.arrayBuffer()), ctx.timeoutMs));
  if (result.state !== 'ok') return result;
  if (result.status === 206) return result;
  return Object.assign({}, result, { body: result.body.subarray(offset, offset + length) });
}

// Asks for a redirect without following it. Outside a browser the answer is the 3xx with its Location;
// a browser hides it (an opaque redirect or a CORS refusal), and the caller then falls back.
export function getRedirect(ctx, url) {
  note(ctx, url);
  return memo(ctx, 'redirect ' + url, async () => {
    try {
      const response = await withTimeout(ctx.fetch(url, { redirect: 'manual', headers: requestHeaders() }), ctx.timeoutMs);
      const location = response.headers && typeof response.headers.get === 'function' ? response.headers.get('location') : null;
      return { state: 'ok', status: response.status, type: response.type, location, url: response.url };
    } catch (error) {
      return { state: 'network', error: String(error && error.message ? error.message : error) };
    }
  });
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timed out after ' + timeoutMs + ' ms')), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// "hex  name" lines, as sha256sum writes them.
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S.*?)\s*$/.exec(line);
    if (match) sums.set(match[2], match[1]);
  }
  return sums;
}

// Where one record sits in the answers file, from the locator built by scripts/build-offsets.mjs.
export function locate(locator, ids) {
  const rows = locator && locator.categories ? locator.categories[ids.category] : null;
  if (!Array.isArray(rows)) return null;
  const engine = locator.engines.indexOf(ids.engine);
  if (engine < 0) return null;
  for (const row of rows) {
    if (row[0] === ids.question && row[1] === engine && row[2] === ids.run) return { offset: row[3], length: row[4] };
  }
  return null;
}
