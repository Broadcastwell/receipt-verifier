// The checks, one set per receipt kind. Each check compares a field of the receipt with the public
// source and answers PASS, FAIL or NOT CHECKABLE with a plain reason. A source that cannot be read is
// NOT CHECKABLE, never FAIL: only a published answer that disagrees with the receipt is a FAIL.

import { plain, excerptCore } from './plain.js';
import { STATUS, sha256Hex } from './report.js';
import * as S from './sources.js';

const HEX64 = /^[0-9a-f]{64}$/;

const pass = reason => ({ status: STATUS.PASS, reason });
const fail = reason => ({ status: STATUS.FAIL, reason });
const notCheckable = reason => ({ status: STATUS.NOT_CHECKABLE, reason });

function reasonFor(result) {
  if (!result || result.state === 'network') return S.NETWORK_REASON;
  if (result.state === 'http') return 'the source answered HTTP ' + result.status;
  if (result.state === 'parse') return 'the source did not answer with JSON';
  return result.reason || S.NETWORK_REASON;
}

function pick(object, fields) {
  const out = {};
  for (const field of fields) {
    if (object && object[field] !== undefined) out[field] = object[field];
  }
  return out;
}

function quoteOf(text) {
  return '"' + String(text) + '"';
}

// Shared checks

function excerptCheck(quote, answerText, unavailable) {
  if (typeof answerText !== 'string') return unavailable;
  if (typeof quote !== 'string') return fail('the excerpt is not text');
  const core = excerptCore(quote);
  if (!core.trim()) return fail('the excerpt is empty');
  if (plain(answerText).includes(core)) {
    return pass('the excerpt appears in the published answer text once its markdown marks are removed and its spacing collapsed');
  }
  return fail('the excerpt does not appear in the published answer text');
}

function citedCheck(claimed, published, unavailable) {
  if (claimed === undefined || (Array.isArray(claimed) && claimed.length === 0)) return notCheckable('the receipt lists no cited pages');
  if (!Array.isArray(claimed) || claimed.some(url => typeof url !== 'string')) return fail('cited_urls is not a list of addresses');
  if (!Array.isArray(published)) return unavailable;
  const absent = claimed.filter(url => !published.includes(url));
  if (absent.length === 0) {
    return pass('every cited page in the receipt (' + claimed.length + ') is among the pages the published answer cites (' + published.length + ')');
  }
  return fail(absent.length + ' of ' + claimed.length + ' cited pages are not among the pages the published answer cites, for example ' + absent[0]);
}

function sameText(label, claimed, published, unavailable, sourceName) {
  if (claimed === undefined) return notCheckable('the receipt names no ' + label);
  if (published === undefined || published === null) return unavailable;
  if (String(claimed) === String(published) && typeof claimed === typeof published) {
    return pass(String(published) + ', as ' + sourceName + ' states');
  }
  return fail(sourceName + ' states ' + quoteOf(published) + '; the receipt states ' + quoteOf(claimed));
}

async function doiCheck(ctx) {
  const id = S.ZENODO_RECORD_ID;
  const probe = await S.getRedirect(ctx, S.DOI_URL);
  if (probe.state === 'ok' && probe.status >= 300 && probe.status < 400 && probe.location) {
    const target = safeUrl(probe.location, S.DOI_URL);
    if (target && target.hostname === 'zenodo.org' && target.pathname.includes(id)) {
      return pass(S.DOI_URL + ' redirects to ' + target.href);
    }
    return fail(S.DOI_URL + ' redirects to ' + (target ? target.href : probe.location) + ', not to Zenodo record ' + id);
  }
  if (probe.state === 'ok' && probe.status === 200 && probe.url) {
    const target = safeUrl(probe.url);
    if (target && target.hostname === 'zenodo.org' && target.pathname.includes(id)) {
      return pass(S.DOI_URL + ' leads to ' + target.href);
    }
  }
  const record = await S.getJson(ctx, S.ZENODO_API_RECORD);
  if (record.state !== 'ok') return notCheckable(reasonFor(record));
  const doi = record.body && record.body.doi;
  if (typeof doi !== 'string') return notCheckable('the Zenodo record answered without a DOI field');
  if (doi === S.DOI) {
    return pass('the redirect could not be read here, so the Zenodo record was read instead: record ' + id + ' carries DOI ' + S.DOI);
  }
  return fail('Zenodo record ' + id + ' carries DOI ' + String(doi) + ', not ' + S.DOI);
}

function safeUrl(text, base) {
  try {
    return new URL(text, base);
  } catch (error) {
    return null;
  }
}

// Index receipts (Absence Index, release 2026-09)

const INDEX_FIELDS = ['record_id', 'engine', 'question_id', 'question', 'run', 'captured_at', 'excerpt', 'cited_urls', 'answer_sha256'];

// The first receipt object anywhere in the category answer that carries this record id.
function findPublishedReceipt(node, recordId, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  if (!Array.isArray(node) && node.record_id === recordId && typeof node.answer_sha256 === 'string') return node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    const found = findPublishedReceipt(value, recordId, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseLine(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    return null;
  }
}

function sameRecord(record, ids) {
  return Boolean(record) && record.category_id === ids.category && String(record.question_id) === ids.question
    && record.engine === ids.engine && Number(record.repeat_index) === ids.run;
}

async function readIndexRecord(ctx, ids, options) {
  const locator = options.offsets || S.LOCATOR;
  if (options.full) return readFromWholeFile(ctx, ids, locator);
  const at = S.locate(locator, ids);
  if (!at) return { state: 'absent' };
  const result = await S.getRange(ctx, S.ANSWERS_URL, at.offset, at.length);
  if (result.state !== 'ok') return { state: 'unreadable', reason: reasonFor(result) };
  const record = parseLine(result.body);
  if (!sameRecord(record, ids)) return { state: 'mismatch' };
  const last = at.offset + at.length - 1;
  return { state: 'found', record, how: 'at bytes ' + at.offset + ' to ' + last + ' of ' + S.ANSWERS_FILE + ' (read by byte range)' };
}

async function readFromWholeFile(ctx, ids, locator) {
  const sums = await S.getText(ctx, S.SUMS_URL);
  if (sums.state !== 'ok') return { state: 'unreadable', reason: reasonFor(sums) };
  const listed = S.parseSums(sums.body).get(S.ANSWERS_FILE);
  const file = await S.getBytes(ctx, S.ANSWERS_URL, Math.max(ctx.timeoutMs, S.FULL_TIMEOUT_MS));
  if (file.state !== 'ok') return { state: 'unreadable', reason: reasonFor(file) };
  const digest = await sha256Hex(file.body);
  if (!listed || digest !== listed || digest !== locator.sha256) {
    return { state: 'untrusted', reason: 'the downloaded answers file hashes to ' + digest + ', which is not the SHA-256 in ' + S.SUMS_FILE + ' and the pinned release, so no record in it was trusted' };
  }
  const how = 'in the whole ' + S.ANSWERS_FILE + ', whose SHA-256 equals its line in ' + S.SUMS_FILE;
  const at = S.locate(locator, ids);
  if (at && at.offset + at.length <= file.body.length) {
    const record = parseLine(file.body.subarray(at.offset, at.offset + at.length));
    if (sameRecord(record, ids)) return { state: 'found', record, how };
  }
  const marker = '"category_id":"' + ids.category + '"';
  for (const line of new TextDecoder().decode(file.body).split('\n')) {
    if (!line.includes(marker)) continue;
    const record = parseLine(new TextEncoder().encode(line));
    if (sameRecord(record, ids)) return { state: 'found', record, how };
  }
  return { state: 'absent' };
}

function recordCheck(located) {
  if (located.state === 'found') {
    const excluded = located.record.excluded ? '; the record is marked excluded: ' + String(located.record.exclusion_reason || 'no reason given') : '';
    return pass('found ' + located.how + '; its category, question, engine and run match the record id' + excluded);
  }
  if (located.state === 'absent') return fail(S.ANSWERS_FILE + ' holds no record with this id');
  if (located.state === 'mismatch') return notCheckable('the bytes at the located range are not this record; run the full check');
  return notCheckable(located.reason || S.NETWORK_REASON);
}

function unavailableFor(located) {
  if (located.state === 'absent') return notCheckable('there is no published record to compare with');
  if (located.state === 'mismatch') return notCheckable('the record could not be read; run the full check');
  return notCheckable(located.reason || S.NETWORK_REASON);
}

function questionsOf(body) {
  const list = body && body.data && Array.isArray(body.data.questions) ? body.data.questions : null;
  return list;
}

// The question text as the Index published it: the public API first, the release file second, and the
// published control questions for a control id.
async function publishedQuestion(ctx, ids, category) {
  let list = null;
  let source = null;
  if (category.state === 'ok' && questionsOf(category.body)) {
    list = questionsOf(category.body);
    source = 'the public API';
  } else {
    const release = await S.getJson(ctx, S.zenodoFileUrl(S.RELEASE_FILE));
    if (release.state !== 'ok') return { state: 'unreadable', reason: reasonFor(release) };
    const entry = (release.body && Array.isArray(release.body.categories) ? release.body.categories : []).find(item => item && item.id === ids.category);
    list = entry && Array.isArray(entry.questions) ? entry.questions : [];
    source = S.RELEASE_FILE;
  }
  const found = list.find(item => item && String(item.id) === ids.question);
  if (found && typeof found.text === 'string') return { state: 'found', text: found.text, source };
  const controls = await S.getJson(ctx, S.zenodoFileUrl(S.CONTROLS_FILE));
  if (controls.state !== 'ok') return { state: 'unreadable', reason: reasonFor(controls) };
  const control = (Array.isArray(controls.body) ? controls.body : []).find(item => item && item.category_id === ids.category && String(item.question_id) === ids.question);
  if (control && typeof control.text === 'string') return { state: 'found', text: control.text, source: S.CONTROLS_FILE + ', a control question' };
  return { state: 'absent' };
}

function indexQuestionCheck(receipt, ids, question, receiptSource) {
  if (receipt.question_id !== undefined && String(receipt.question_id) !== ids.question) {
    return fail('the published record answers question ' + ids.question + '; the receipt states question_id ' + String(receipt.question_id));
  }
  if (receipt.question === undefined) {
    if (receiptSource === 'dataset' && question && question.state !== 'found') {
      return notCheckable(question.state === 'absent' ? 'no published question text for question ' + ids.question + ' in ' + ids.category : question.reason);
    }
    return notCheckable('the receipt quotes no question');
  }
  if (!question || question.state === 'unreadable') return notCheckable(question ? question.reason : S.NETWORK_REASON);
  if (question.state === 'absent') return notCheckable('no published question text for question ' + ids.question + ' in ' + ids.category);
  if (receipt.question === question.text) {
    return pass('equal to question ' + ids.question + ' as the Index published it (' + question.source + ')');
  }
  return fail('question ' + ids.question + ' as the Index published it reads ' + quoteOf(question.text) + '; the receipt quotes ' + quoteOf(receipt.question));
}

async function indexHashCheck(receipt, record, unavailable, receiptSource) {
  if (!record) return unavailable;
  if (typeof record.answer_text !== 'string') return notCheckable('the published record has no answer text');
  const actual = await sha256Hex(record.answer_text);
  if (receiptSource === 'dataset') return pass('the receipt is the dataset record itself; SHA-256 of its answer text is ' + actual);
  const claimed = receipt.answer_sha256;
  if (claimed === undefined) return notCheckable('the receipt carries no answer hash');
  if (typeof claimed !== 'string' || !HEX64.test(claimed.toLowerCase())) return fail('answer_sha256 in the receipt is not a SHA-256 hex digest');
  if (claimed.toLowerCase() === actual) return pass('SHA-256 of the published answer text is ' + actual + ', as the receipt states');
  return fail('SHA-256 of the published answer text is ' + actual + '; the receipt states ' + claimed);
}

async function receiptFromRecord(record, ids, question) {
  const receipt = { record_id: ids.recordId, engine: record.engine };
  if (question && question.state === 'found') receipt.question = question.text;
  receipt.run = record.repeat_index;
  receipt.captured_at = record.captured_at;
  receipt.cited_urls = Array.isArray(record.cited_urls) ? record.cited_urls.slice(0, 3) : [];
  receipt.answer_sha256 = await sha256Hex(String(record.answer_text));
  return receipt;
}

export async function checkIndex(parsed, ctx, options) {
  const ids = parsed.ids;
  const locator = options.offsets || S.LOCATOR;
  const [category, located, doi] = await Promise.all([
    S.getJson(ctx, S.categoryUrl(ids.category)),
    readIndexRecord(ctx, ids, options),
    doiCheck(ctx)
  ]);
  const apiData = category.state === 'ok' && category.body ? category.body.data : null;
  let receipt = null;
  let receiptSource;
  let noExcerpt = 'no published excerpt for this record';
  if (parsed.receipt) {
    receipt = pick(parsed.receipt, INDEX_FIELDS);
    receiptSource = 'given';
    noExcerpt = 'the receipt quotes no excerpt';
  } else {
    const published = apiData ? findPublishedReceipt(apiData, ids.recordId) : null;
    if (published) {
      receipt = pick(published, INDEX_FIELDS);
      receiptSource = 'api';
    } else if (located.state === 'found') {
      receiptSource = 'dataset';
      if (category.state !== 'ok' && !(category.state === 'http' && category.status === 404)) noExcerpt = reasonFor(category);
    } else {
      receipt = { record_id: ids.recordId };
      receiptSource = 'id';
    }
  }
  const needsQuestion = receiptSource === 'dataset' || (receipt && receipt.question !== undefined);
  const question = needsQuestion ? await publishedQuestion(ctx, ids, category) : null;
  if (receiptSource === 'dataset') receipt = await receiptFromRecord(located.record, ids, question);
  const record = located.state === 'found' ? located.record : null;
  const unavailable = unavailableFor(located);
  const checks = {
    record: recordCheck(located),
    hash: await indexHashCheck(receipt, record, unavailable, receiptSource),
    excerpt: receipt.excerpt === undefined ? notCheckable(noExcerpt) : excerptCheck(receipt.excerpt, record && record.answer_text, unavailable),
    cited_pages: citedCheck(receipt.cited_urls, record ? record.cited_urls : undefined, unavailable),
    engine: sameText('engine', receipt.engine, record ? record.engine : undefined, unavailable, 'the published record'),
    question: indexQuestionCheck(receipt, ids, question, receiptSource),
    run: sameRun(receipt.run, record, unavailable),
    captured_at: sameText('capture time', receipt.captured_at, record ? record.captured_at : undefined, unavailable, 'the published record'),
    doi
  };
  return {
    kind: 'index',
    subject: ids.recordId,
    receipt,
    receiptSource,
    checks,
    dataset: { doi: S.DOI, release: S.RELEASE_ID, file: S.ANSWERS_FILE, sha256: locator.sha256 }
  };
}

function sameRun(claimed, record, unavailable) {
  if (claimed === undefined) return notCheckable('the receipt names no run');
  if (!record) return unavailable;
  const comparable = typeof claimed === 'number' || typeof claimed === 'string';
  if (comparable && String(claimed) === String(record.repeat_index)) return pass('run ' + record.repeat_index + ', the repeat_index of the published record');
  return fail('the published record is run ' + record.repeat_index + '; the receipt states run ' + String(claimed));
}

// Sample receipts (the fictional Kalvenor Systems sample)

const SAMPLE_FIELDS = ['receipt_id', 'run_id', 'pass_id', 'question_id', 'question_text', 'engine', 'engine_label', 'cited_urls', 'answer_text', 'answer_sha256', 'excerpt', 'observed_at'];

function normalizeSample(object) {
  if (object.baseline_id !== undefined || object.answer_full !== undefined) {
    return pick({
      receipt_id: object.id,
      run_id: object.baseline_id,
      pass_id: object.run_id,
      question_id: object.question_id,
      question_text: object.question_text,
      engine: object.engine,
      engine_label: object.engine_label,
      cited_urls: object.cited_urls,
      answer_text: object.answer_full,
      answer_sha256: object.answer_sha256,
      excerpt: object.excerpt,
      observed_at: object.observed_at
    }, SAMPLE_FIELDS);
  }
  const out = pick(object, SAMPLE_FIELDS);
  if (out.receipt_id === undefined && typeof object.id === 'string') out.receipt_id = object.id;
  if (out.observed_at === undefined && object.captured_at !== undefined) out.observed_at = object.captured_at;
  return out;
}

function engineLabels(body) {
  return body && body.summary && body.summary.engine_labels && typeof body.summary.engine_labels === 'object' ? body.summary.engine_labels : {};
}

function receiptFromObservation(observation, body) {
  return pick({
    receipt_id: observation.id,
    run_id: body.baseline_id !== undefined ? body.baseline_id : observation.baseline_id,
    pass_id: observation.run_id,
    question_id: observation.question_id,
    question_text: observation.question_text,
    engine: observation.engine,
    engine_label: engineLabels(body)[observation.engine],
    cited_urls: observation.cited_urls,
    answer_text: observation.answer_full,
    observed_at: observation.observed_at
  }, SAMPLE_FIELDS);
}

async function sampleHashCheck(receipt, observation, unavailable) {
  if (!observation) return unavailable;
  if (typeof observation.answer_full !== 'string') return notCheckable('the published observation has no answer text');
  const actual = await sha256Hex(observation.answer_full);
  if (receipt.answer_sha256 !== undefined) {
    const claimed = receipt.answer_sha256;
    if (typeof claimed !== 'string' || !HEX64.test(claimed.toLowerCase())) return fail('answer_sha256 in the receipt is not a SHA-256 hex digest');
    if (claimed.toLowerCase() === actual) return pass('SHA-256 of answer_full in the sample export is ' + actual + ', as the receipt states');
    return fail('SHA-256 of answer_full in the sample export is ' + actual + '; the receipt states ' + claimed);
  }
  if (typeof receipt.answer_text === 'string') {
    const quoted = await sha256Hex(receipt.answer_text);
    if (quoted === actual) return pass('SHA-256 of the answer text in the receipt equals SHA-256 of answer_full in the sample export: ' + actual);
    return fail('SHA-256 of the answer text in the receipt is ' + quoted + '; SHA-256 of answer_full in the sample export is ' + actual);
  }
  return notCheckable('the receipt carries neither an answer hash nor the answer text');
}

function sampleExcerptCheck(receipt, observation, unavailable) {
  if (receipt.excerpt !== undefined) return excerptCheck(receipt.excerpt, observation && observation.answer_full, unavailable);
  if (receipt.answer_text === undefined) return notCheckable('the receipt quotes no answer text');
  if (!observation || typeof observation.answer_full !== 'string') return unavailable;
  if (typeof receipt.answer_text !== 'string') return fail('answer_text is not text');
  const quoted = plain(receipt.answer_text);
  if (quoted && plain(observation.answer_full).includes(quoted)) return pass('the answer text quoted in the receipt matches answer_full in the sample export');
  return fail('the answer text quoted in the receipt does not match answer_full in the sample export');
}

function sampleEngineCheck(receipt, observation, labels, unavailable) {
  const engine = sameText('engine', receipt.engine, observation ? observation.engine : undefined, unavailable, 'the sample export');
  if (engine.status !== STATUS.PASS || receipt.engine_label === undefined || labels[observation.engine] === undefined) return engine;
  if (receipt.engine_label === labels[observation.engine]) return pass(observation.engine + ' (' + labels[observation.engine] + '), as the sample export states');
  return fail('the sample export labels ' + observation.engine + ' as ' + quoteOf(labels[observation.engine]) + '; the receipt states ' + quoteOf(receipt.engine_label));
}

function sampleQuestionCheck(receipt, observation, body, unavailable) {
  if (receipt.question_text === undefined && receipt.question_id === undefined) return notCheckable('the receipt quotes no question');
  if (!observation) return unavailable;
  if (receipt.question_id !== undefined && String(receipt.question_id) !== String(observation.question_id)) {
    return fail('the observation answers question ' + observation.question_id + '; the receipt states question ' + String(receipt.question_id));
  }
  if (receipt.question_text === undefined) return notCheckable('the receipt quotes no question text');
  const listed = Array.isArray(body.questions) ? body.questions.find(item => item && String(item.question_id) === String(observation.question_id)) : null;
  if (listed && listed.question_text !== observation.question_text) return notCheckable('the sample export quotes question ' + observation.question_id + ' in two different ways');
  if (receipt.question_text === observation.question_text) return pass('equal to question ' + observation.question_id + ' as the sample export publishes it');
  return fail('question ' + observation.question_id + ' in the sample export reads ' + quoteOf(observation.question_text) + '; the receipt quotes ' + quoteOf(receipt.question_text));
}

function sampleRunCheck(receipt, observation, body, unavailable) {
  if (receipt.run_id === undefined && receipt.pass_id === undefined) return notCheckable('the receipt names no run');
  if (!observation) return unavailable;
  const baseline = body.baseline_id !== undefined ? body.baseline_id : observation.baseline_id;
  if (receipt.run_id !== undefined && receipt.run_id !== baseline) {
    return fail('the sample export is run ' + quoteOf(baseline) + '; the receipt states run ' + quoteOf(receipt.run_id));
  }
  if (receipt.pass_id !== undefined && receipt.pass_id !== observation.run_id) {
    return fail('the observation belongs to pass ' + quoteOf(observation.run_id) + '; the receipt states pass ' + quoteOf(receipt.pass_id));
  }
  const parts = [];
  if (receipt.run_id !== undefined) parts.push('run ' + baseline);
  if (receipt.pass_id !== undefined) parts.push('pass ' + observation.run_id);
  return pass(parts.join(', ') + ', as the sample export states');
}

export async function checkSample(parsed, ctx) {
  const exported = await S.getJson(ctx, S.SAMPLE_EXPORT_URL);
  const body = exported.state === 'ok' && exported.body && typeof exported.body === 'object' ? exported.body : null;
  const observations = body && Array.isArray(body.observations) ? body.observations : null;
  const observation = observations ? observations.find(item => item && item.id === parsed.observationId) || null : null;
  let unavailable;
  if (!body) unavailable = notCheckable(reasonFor(exported));
  else if (!observations) unavailable = notCheckable('the sample export holds no observations');
  else unavailable = notCheckable('there is no published observation to compare with');
  let receipt;
  let receiptSource;
  if (parsed.receipt) {
    receipt = normalizeSample(parsed.receipt);
    receiptSource = 'given';
  } else if (observation) {
    receipt = receiptFromObservation(observation, body);
    receiptSource = 'export';
  } else {
    receipt = { receipt_id: parsed.observationId };
    receiptSource = 'id';
  }
  let record;
  if (observation) {
    const client = body.client && body.client.name ? ' for ' + body.client.name : '';
    record = pass('observation ' + observation.id + ' is in the sample export' + client + '; the company is fictional');
  } else if (observations) {
    record = fail('the sample export holds no observation with this id');
  } else {
    record = unavailable;
  }
  const checks = {
    record,
    hash: await sampleHashCheck(receipt, observation, unavailable),
    excerpt: sampleExcerptCheck(receipt, observation, unavailable),
    cited_pages: citedCheck(receipt.cited_urls, observation ? observation.cited_urls : undefined, unavailable),
    engine: sampleEngineCheck(receipt, observation, engineLabels(body), unavailable),
    question: sampleQuestionCheck(receipt, observation, body || {}, unavailable),
    run: sampleRunCheck(receipt, observation, body || {}, unavailable),
    captured_at: sameText('capture time', receipt.observed_at, observation ? observation.observed_at : undefined, unavailable, 'the sample export'),
    doi: notCheckable('the sample is fictional and has no DOI')
  };
  return {
    kind: 'sample',
    subject: parsed.observationId,
    receipt,
    receiptSource,
    checks,
    dataset: { source: S.SAMPLE_EXPORT_URL, fictional: true }
  };
}

// Decision Receipts (a shared run: Public Fix day 0, or an account's own share link)

const DECISION_FIELDS = ['receipts_url', 'hash', 'run_id', 'receipts', 'algorithm'];
const SHARE_LINK = /^https:\/\/app\.broadcastwell\.com\/s\/([0-9a-f]{64})(?:[?#].*)?$/;
const PRINTED_HASH = /receipt-hash[^>]*>\s*<code>([0-9a-f]{64})</;
const NOT_PUBLIC = 'the answer texts of a shared run are not public';

function decisionChecks(overrides) {
  return Object.assign({
    excerpt: notCheckable(NOT_PUBLIC),
    cited_pages: notCheckable(NOT_PUBLIC),
    engine: notCheckable('a Decision Receipt covers a whole run, not one engine'),
    question: notCheckable('a Decision Receipt covers a whole run, not one question'),
    captured_at: notCheckable('the share link publishes no capture time to compare'),
    doi: notCheckable('a Decision Receipt is not part of the published dataset and has no DOI')
  }, overrides);
}

async function resolvePublicFix(ctx, slug) {
  const fix = await S.getJson(ctx, S.publicFixUrl(slug));
  if (fix.state === 'http' && fix.status === 404) return { state: 'absent' };
  if (fix.state !== 'ok') return { state: 'unreadable', reason: reasonFor(fix) };
  const data = fix.body && fix.body.data;
  const link = data && data.day0 && typeof data.day0.receipts_url === 'string' ? data.day0.receipts_url : '';
  const match = SHARE_LINK.exec(link);
  if (!match) return { state: 'nolink' };
  return { state: 'ok', token: match[1] };
}

// The published hash for a link given without one: as printed on the share page, or, when the page
// cannot be read, as the app reports it.
async function publishedHash(ctx, token) {
  const page = await S.getText(ctx, S.shareUrl(token));
  if (page.state === 'http' && page.status === 404) return { state: 'absent' };
  if (page.state === 'ok') {
    const match = PRINTED_HASH.exec(page.body);
    if (match) return { state: 'ok', hash: match[1], from: 'page' };
  }
  const reported = await S.getJson(ctx, S.shareVerifyUrl(token, ''));
  if (reported.state === 'ok' && reported.body && typeof reported.body.hash === 'string' && HEX64.test(reported.body.hash)) {
    return { state: 'ok', hash: reported.body.hash, from: 'app' };
  }
  if (reported.state === 'http' && reported.status === 404) return { state: 'absent' };
  return { state: 'unreadable', reason: reasonFor(page.state !== 'ok' ? page : reported) };
}

function decisionHashCheck(claimed, verified, from, algorithm) {
  if (claimed === undefined || claimed === null) return notCheckable('the receipt carries no hash');
  if (typeof claimed !== 'string' || !HEX64.test(claimed.toLowerCase())) return fail('the hash in the receipt is not a SHA-256 hex digest');
  if (verified.state !== 'ok') return notCheckable(reasonFor(verified));
  const answer = verified.body || {};
  if (algorithm !== undefined && typeof answer.algorithm === 'string' && algorithm !== answer.algorithm) {
    return fail('the app hashes the run with ' + answer.algorithm + '; the receipt states ' + quoteOf(algorithm));
  }
  const count = Number.isFinite(answer.receipts) ? answer.receipts + ' ' : '';
  if (answer.matches === true && String(answer.hash).toLowerCase() === claimed.toLowerCase()) {
    let where = '';
    if (from === 'page') where = ' printed on the share page';
    if (from === 'app') where = ' the app reports for this link (the share page could not be read)';
    return pass('the app recomputed SHA-256 over the ' + count + 'stored receipts of the run and it equals the published hash' + where + ': ' + claimed.toLowerCase());
  }
  if (answer.matches === false) {
    return fail('the app recomputed ' + String(answer.hash) + ' from the ' + count + 'stored receipts of the run; the receipt states ' + claimed);
  }
  return notCheckable('the app did not say whether the hash matches');
}

function decisionRunCheck(receipt, verified) {
  if (receipt.run_id === undefined && receipt.receipts === undefined) return notCheckable('the receipt names no run id to compare');
  if (verified.state !== 'ok') return notCheckable(reasonFor(verified));
  const answer = verified.body || {};
  if (receipt.run_id !== undefined && receipt.run_id !== answer.run_id) {
    return fail('the share link holds run ' + quoteOf(answer.run_id) + '; the receipt states run ' + quoteOf(receipt.run_id));
  }
  if (receipt.receipts !== undefined && receipt.receipts !== answer.receipts) {
    return fail('the share link holds ' + String(answer.receipts) + ' receipts; the receipt states ' + String(receipt.receipts));
  }
  return pass('run ' + String(answer.run_id) + ' with ' + String(answer.receipts) + ' stored receipts, as the share link states');
}

export async function checkDecision(parsed, ctx) {
  let token = parsed.token;
  let subject = token ? S.shareUrl(token) : '';
  if (parsed.kind === 'publicfix') {
    subject = 'Public Fix ' + parsed.slug + ', day 0';
    const fix = await resolvePublicFix(ctx, parsed.slug);
    if (fix.state !== 'ok') {
      let record = notCheckable(fix.reason || S.NETWORK_REASON);
      if (fix.state === 'absent') record = fail('the app has no Public Fix run named ' + parsed.slug);
      if (fix.state === 'nolink') record = notCheckable('the Public Fix record publishes no day 0 receipts link yet');
      const hash = notCheckable(fix.state === 'unreadable' ? fix.reason : 'there is no published hash to compare');
      return decisionResult(subject, { public_fix: parsed.slug }, 'link', decisionChecks({ record, hash, run: notCheckable('the receipt names no run id to compare') }), null);
    }
    token = fix.token;
  }
  let receipt;
  let receiptSource;
  let from = null;
  let claimed;
  let hashUnread = null;
  if (parsed.receipt) {
    receipt = Object.assign(pick(parsed.receipt, DECISION_FIELDS), { receipts_url: S.shareUrl(token) });
    receiptSource = 'given';
    claimed = receipt.hash;
  } else if (parsed.hash) {
    receipt = { receipts_url: S.shareUrl(token), hash: parsed.hash };
    receiptSource = 'link';
    claimed = parsed.hash;
  } else {
    const published = await publishedHash(ctx, token);
    if (published.state === 'absent') {
      const record = fail('the app has no shared run at this link');
      return decisionResult(subject, { receipts_url: S.shareUrl(token) }, 'link', decisionChecks({ record, hash: notCheckable('there is no published hash to compare'), run: notCheckable('the receipt names no run id to compare') }), token);
    }
    receipt = { receipts_url: S.shareUrl(token) };
    if (published.state === 'ok') receipt.hash = published.hash;
    else hashUnread = notCheckable(published.reason || S.NETWORK_REASON);
    receiptSource = published.from === 'app' ? 'app' : 'page';
    from = published.from || null;
    claimed = receipt.hash;
  }
  const usable = typeof claimed === 'string' && HEX64.test(claimed.toLowerCase());
  const verified = await S.getJson(ctx, S.shareVerifyUrl(token, usable ? claimed.toLowerCase() : ''));
  let record;
  if (verified.state === 'ok' && verified.body && typeof verified.body.run_id === 'string') {
    record = pass('the share link answers for run ' + verified.body.run_id + ' with ' + String(verified.body.receipts) + ' stored receipts');
  } else if (verified.state === 'http' && verified.status === 404) {
    record = fail('the app has no shared run at this link');
  } else if (verified.state === 'ok') {
    record = notCheckable('the share link did not name its run');
  } else {
    record = notCheckable(reasonFor(verified));
  }
  const hash = hashUnread || decisionHashCheck(claimed, verified, from, receipt.algorithm);
  const checks = decisionChecks({ record, hash, run: decisionRunCheck(receipt, verified) });
  return decisionResult(subject, receipt, receiptSource, checks, token);
}

function decisionResult(subject, receipt, receiptSource, checks, token) {
  return {
    kind: 'decision',
    subject,
    receipt,
    receiptSource,
    checks,
    dataset: { source: token ? S.shareUrl(token) : S.APP_ORIGIN, algorithm: 'SHA-256' }
  };
}
