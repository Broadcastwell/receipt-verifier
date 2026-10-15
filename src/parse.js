// Input recognition. verify() accepts:
//   an Index record id            crm|1|ChatGPT|1
//   a receipt URL                 any URL with record=<id> or #<id>; app.broadcastwell.com/s/<64 hex>
//                                 (optionally ?verify=<hash>); /public-fix/<slug> or /api/v1/public-fix/<slug>;
//                                 any URL naming observation-<uuid>; this tool's own page with ?receipt=<url>
//   a sample id                   sample:observation-<uuid> or a bare observation-<uuid>
//   a receipt JSON                an Index, sample or Decision receipt, as an object or a JSON string
// A JSON receipt is checked as given: its own fields are compared with the sources.

const APP_HOST = 'app.broadcastwell.com';
const PUBLIC_FIX_HOSTS = ['app.broadcastwell.com', 'broadcastwell.com', 'www.broadcastwell.com'];
const OBSERVATION = /observation-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const OBSERVATION_ID = new RegExp('^' + OBSERVATION.source + '$');
const SHARE_PATH = /^\/s\/([0-9a-f]{64})\/?$/;
const PUBLIC_FIX_PATH = /^\/(?:api\/v1\/)?public-fix\/([a-z0-9][a-z0-9-]{0,79})\/?$/;
const MAX_INPUT = 200000;

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

// <category id>|<question id>|<engine>|<run>
export function parseRecordId(text) {
  if (typeof text !== 'string') return null;
  const parts = text.trim().split('|');
  if (parts.length !== 4) return null;
  const [category, question, engine, run] = parts.map(part => part.trim());
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(category)) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(question)) return null;
  if (!/^[A-Za-z][A-Za-z0-9 .]{0,39}$/.test(engine)) return null;
  if (!/^[1-9][0-9]{0,2}$/.test(run)) return null;
  return { category, question, engine, run: Number(run), recordId: [category, question, engine, run].join('|') };
}

function decodeMaybe(text) {
  try {
    return decodeURIComponent(text);
  } catch (error) {
    return text;
  }
}

export function parseInput(input, depth = 0) {
  if (depth > 2) throw new InputError('the receipt link is nested too deeply');
  if (input && typeof input === 'object') return parseObject(input, depth);
  if (typeof input !== 'string') throw new InputError('give a record id, a receipt URL or a receipt JSON');
  const text = input.trim();
  if (!text) throw new InputError('give a record id, a receipt URL or a receipt JSON');
  if (text.length > MAX_INPUT) throw new InputError('the input is too long to be a receipt');
  if (text.startsWith('{')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new InputError('the input looks like JSON but does not parse');
    }
    return parseObject(parsed, depth);
  }
  if (/^https?:\/\//i.test(text)) return parseUrl(text, depth);
  if (/^sample:/i.test(text)) {
    const id = text.slice('sample:'.length).trim();
    if (!OBSERVATION_ID.test(id)) throw new InputError('a sample id is sample:observation-<uuid>');
    return { kind: 'sample', observationId: id };
  }
  if (OBSERVATION_ID.test(text)) return { kind: 'sample', observationId: text };
  const ids = parseRecordId(text.includes('%7C') || text.includes('%7c') ? decodeMaybe(text) : text);
  if (ids) return { kind: 'index', recordId: ids.recordId, ids };
  throw new InputError('not a record id (category|question|engine|run), a receipt URL or a receipt JSON');
}

function parseUrl(text, depth) {
  let url;
  try {
    url = new URL(text);
  } catch (error) {
    throw new InputError('the URL does not parse');
  }
  const host = url.hostname.toLowerCase();
  const inner = url.searchParams.get('receipt');
  if (inner) return parseInput(inner, depth + 1);
  const record = url.searchParams.get('record');
  if (record) {
    const ids = parseRecordId(record);
    if (!ids) throw new InputError('the record= value is not a record id (category|question|engine|run)');
    return { kind: 'index', recordId: ids.recordId, ids };
  }
  const share = SHARE_PATH.exec(url.pathname);
  if (share) {
    if (host !== APP_HOST) throw new InputError('a Decision Receipt link is on ' + APP_HOST);
    const verify = url.searchParams.get('verify');
    return { kind: 'decision', token: share[1], hash: verify ? verify.trim().toLowerCase().slice(0, 200) : null };
  }
  const fix = PUBLIC_FIX_PATH.exec(url.pathname);
  if (fix) {
    if (!PUBLIC_FIX_HOSTS.includes(host)) throw new InputError('a Public Fix link is on ' + APP_HOST);
    return { kind: 'publicfix', slug: fix[1] };
  }
  const observation = OBSERVATION.exec(url.pathname + url.search + url.hash);
  if (observation) return { kind: 'sample', observationId: observation[0] };
  if (url.hash.length > 1) {
    const ids = parseRecordId(decodeMaybe(url.hash.slice(1)));
    if (ids) return { kind: 'index', recordId: ids.recordId, ids };
  }
  throw new InputError('this URL carries no record id, receipt link, sample observation or Public Fix run');
}

function parseObject(object, depth) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new InputError('a receipt JSON is an object');
  // A wrapper that carries a receipt: a vendor entry from the category API, or a report from this tool.
  if (object.receipt && typeof object.receipt === 'object' && !Array.isArray(object.receipt)) {
    if (depth > 2) throw new InputError('the receipt is nested too deeply');
    return parseObject(object.receipt, depth + 1);
  }
  if (typeof object.record_id === 'string') {
    const ids = parseRecordId(object.record_id);
    if (!ids) throw new InputError('record_id is not a record id (category|question|engine|run)');
    return { kind: 'index', recordId: ids.recordId, ids, receipt: object };
  }
  const sampleId = typeof object.receipt_id === 'string' ? object.receipt_id : (typeof object.id === 'string' ? object.id : '');
  if (sampleId && OBSERVATION.test(sampleId)) {
    return { kind: 'sample', observationId: OBSERVATION.exec(sampleId)[0], receipt: object };
  }
  const link = typeof object.receipts_url === 'string' ? object.receipts_url : (typeof object.url === 'string' ? object.url : '');
  if (link) {
    let url;
    try {
      url = new URL(link);
    } catch (error) {
      throw new InputError('receipts_url does not parse');
    }
    const share = SHARE_PATH.exec(url.pathname);
    if (!share || url.hostname.toLowerCase() !== APP_HOST) throw new InputError('receipts_url is a link of the form https://' + APP_HOST + '/s/<64 hex>');
    return { kind: 'decision', token: share[1], hash: null, receipt: object };
  }
  throw new InputError('this JSON is not an Index, sample or Decision receipt');
}
