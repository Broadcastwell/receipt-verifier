// The report: canonical JSON, SHA-256, the verdict and the verification id.
//
// The verification id is the SHA-256 (hex) of the canonical JSON (keys sorted, no whitespace) of
//   { verifier: { name, version }, kind, receipt, checks: [{ id, status }], verdict, dataset }
// The time of the check is not part of it, so the same receipt checked against the same sources always
// gets the same id.

export const NAME = 'receipt-verifier';
export const VERSION = '1.0.0';

export const STATUS = Object.freeze({ PASS: 'PASS', FAIL: 'FAIL', NOT_CHECKABLE: 'NOT CHECKABLE' });
export const VERDICT = Object.freeze({ VERIFIED: 'VERIFIED', FAILED: 'FAILED', INCOMPLETE: 'INCOMPLETE' });
export const CHECK_IDS = Object.freeze(['record', 'hash', 'excerpt', 'cited_pages', 'engine', 'question', 'run', 'captured_at', 'doi']);

export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(item => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
  }
  const keys = Object.keys(value).filter(key => value[key] !== undefined).sort();
  return '{' + keys.map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

const HEX = '0123456789abcdef';

export async function sha256Hex(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
  let out = '';
  for (const byte of digest) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

export function verdictOf(checks) {
  if (checks.some(check => check.status === STATUS.FAIL)) return VERDICT.FAILED;
  const passed = id => checks.some(check => check.id === id && check.status === STATUS.PASS);
  return passed('record') && passed('hash') ? VERDICT.VERIFIED : VERDICT.INCOMPLETE;
}

// checks: an object keyed by check id, each { status, reason }. Every id must be present.
export async function buildReport({ kind, subject, receipt, receiptSource, checks, dataset, sources }) {
  const ordered = CHECK_IDS.map(id => {
    const check = checks[id];
    if (!check) throw new Error('internal: no result for the ' + id + ' check');
    return { id, status: check.status, reason: check.reason };
  });
  const verdict = verdictOf(ordered);
  const verifier = { name: NAME, version: VERSION };
  const identity = {
    verifier,
    kind,
    receipt,
    checks: ordered.map(({ id, status }) => ({ id, status })),
    verdict,
    dataset
  };
  return {
    verifier,
    kind,
    subject,
    receipt_source: receiptSource,
    receipt,
    checks: ordered,
    verdict,
    dataset,
    verification_id: await sha256Hex(canonicalJson(identity)),
    checked_at: new Date().toISOString(),
    sources: sources.slice()
  };
}
