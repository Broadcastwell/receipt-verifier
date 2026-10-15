// The receipt verifier page: reads ?record= or ?receipt= and runs at once, or runs on Verify.
// Everything is built with text nodes; nothing from a receipt or a source is parsed as HTML.

import { verify, VERSION } from '../src/index.js';

const STATUS_CLASS = { 'PASS': 'pass', 'FAIL': 'fail', 'NOT CHECKABLE': 'notcheckable' };
const CHECK_NAMES = {
  record: 'Record',
  hash: 'Hash',
  excerpt: 'Excerpt',
  cited_pages: 'Cited pages',
  engine: 'Engine',
  question: 'Question',
  run: 'Run',
  captured_at: 'Capture time',
  doi: 'DOI'
};
const KIND_NAMES = { index: 'Index receipt', sample: 'Sample receipt (fictional company)', decision: 'Decision Receipt' };
const VERDICT_TEXT = {
  VERIFIED: 'The record exists at its public source, its hash matches, and no check failed.',
  FAILED: 'At least one field of this receipt disagrees with its public source.',
  INCOMPLETE: 'Nothing failed, but the record or its hash could not be checked from here.'
};

// The input the page was opened with: ?record=<record id> or ?receipt=<receipt URL>.
export function initialInput(search) {
  const params = new URLSearchParams(search || '');
  return (params.get('record') || params.get('receipt') || '').trim();
}

// The address to show for a checked input, so the result can be shared. JSON is never put in the URL.
export function shareableSearch(input) {
  const text = String(input || '').trim();
  if (!text || text.startsWith('{')) return '';
  const key = /^https?:/i.test(text) ? 'receipt' : 'record';
  return '?' + key + '=' + encodeURIComponent(text);
}

function el(tag, attributes, children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes || {})) node.setAttribute(name, value);
  for (const child of [].concat(children || [])) {
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function renderReport(report) {
  const verdict = document.getElementById('verdict');
  clear(verdict);
  verdict.className = 'verdict ' + report.verdict.toLowerCase();
  verdict.append(el('span', {}, 'Verdict: ' + report.verdict), el('p', {}, VERDICT_TEXT[report.verdict] || ''));

  const facts = document.getElementById('facts');
  clear(facts);
  const fact = (term, value, mono) => facts.append(el('dt', {}, term), el('dd', mono ? { class: 'mono' } : {}, value));
  fact('Receipt', KIND_NAMES[report.kind] || report.kind);
  fact('Checked', report.subject || '');
  fact('Verification id', report.verification_id, true);
  fact('Checked at', report.checked_at, true);

  const checks = document.getElementById('checks');
  clear(checks);
  for (const check of report.checks) {
    checks.append(el('li', {}, [
      el('span', { class: 'status-cell' }, el('span', { class: 'status ' + (STATUS_CLASS[check.status] || '') }, check.status)),
      el('span', { class: 'name' }, (CHECK_NAMES[check.id] || check.id) + ' (' + check.id + ')'),
      el('span', { class: 'reason' }, check.reason)
    ]));
  }

  const sources = document.getElementById('sources');
  clear(sources);
  for (const source of report.sources) sources.append(el('li', {}, el('a', { href: source, rel: 'noopener noreferrer' }, source)));
  if (!report.sources.length) sources.append(el('li', {}, 'none'));

  document.getElementById('raw-json').textContent = JSON.stringify(report, null, 2);
  const result = document.getElementById('result');
  result.hidden = false;
  document.getElementById('result-heading').focus({ preventScroll: false });
}

function showError(message) {
  const box = document.getElementById('form-error');
  box.textContent = message;
  box.hidden = !message;
}

async function check(input) {
  const button = document.getElementById('verify-button');
  const form = document.getElementById('verify-form');
  showError('');
  if (!input.trim()) {
    showError('Paste a record id, a receipt link or a receipt JSON first.');
    document.getElementById('receipt-input').focus();
    return;
  }
  const buttons = Array.from(form.querySelectorAll('button'));
  for (const item of buttons) item.disabled = true;
  button.textContent = 'Checking';
  form.setAttribute('aria-busy', 'true');
  try {
    const report = await verify(input);
    renderReport(report);
    const search = shareableSearch(input);
    if (window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', search || window.location.pathname);
    }
  } catch (error) {
    document.getElementById('result').hidden = true;
    showError(error && error.name === 'InputError' ? error.message.charAt(0).toUpperCase() + error.message.slice(1) + '.' : 'The receipt could not be checked: ' + (error && error.message ? error.message : String(error)));
  } finally {
    for (const item of buttons) item.disabled = false;
    button.textContent = 'Verify';
    form.removeAttribute('aria-busy');
  }
}

function wire() {
  const form = document.getElementById('verify-form');
  const field = document.getElementById('receipt-input');
  document.getElementById('result-heading').setAttribute('tabindex', '-1');
  document.getElementById('version').textContent = 'receipt-verifier ' + VERSION;
  form.addEventListener('submit', event => {
    event.preventDefault();
    check(field.value);
  });
  for (const button of document.querySelectorAll('[data-example]')) {
    button.addEventListener('click', () => {
      field.value = button.getAttribute('data-example');
      check(field.value);
    });
  }
  const start = initialInput(window.location.search);
  if (start) {
    field.value = start;
    check(start);
  }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();
}
