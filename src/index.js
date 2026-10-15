// Broadcastwell receipt verifier: checks a receipt against the published dataset and the public API,
// so anyone can test a claim without trusting Broadcastwell. Runs unchanged in Node 20 and later,
// browsers and Cloudflare Workers. No engine code: no prompts, no question bank, no measurement.
//
//   import { verify } from './src/index.js';
//   const report = await verify('crm|1|ChatGPT|1');
//   report.verdict          VERIFIED, FAILED or INCOMPLETE
//   report.checks           [{ id, status, reason }] in a fixed order
//   report.verification_id  the same for the same receipt checked against the same sources
//
// options: { fetch, full, offsets, timeoutMs }
//   fetch      a fetch function to use instead of globalThis.fetch
//   full       read the whole answers file once and check its SHA-256 (default: one record by byte range)
//   offsets    a locator to use instead of data/answers-2026-09.offsets.json
//   timeoutMs  per request (default 15000)

import { parseInput, InputError } from './parse.js';
import { checkIndex, checkSample, checkDecision } from './checks.js';
import { buildReport, VERSION } from './report.js';
import { createContext } from './sources.js';

export { VERSION, InputError };

export async function verify(input, options = {}) {
  const settings = options && typeof options === 'object' ? options : {};
  if (settings.offsets !== undefined && (!settings.offsets || typeof settings.offsets !== 'object' || !settings.offsets.categories)) {
    throw new TypeError('options.offsets is a locator object with categories');
  }
  const parsed = parseInput(input);
  const ctx = createContext(settings);
  const check = parsed.kind === 'index' ? checkIndex : (parsed.kind === 'sample' ? checkSample : checkDecision);
  const result = await check(parsed, ctx, { full: settings.full === true, offsets: settings.offsets });
  return buildReport(Object.assign({}, result, { sources: ctx.sources }));
}
