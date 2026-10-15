import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initialInput, shareableSearch } from '../web/app.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');

test('the page starts from ?record= or ?receipt=', () => {
  assert.equal(initialInput('?record=crm%7C1%7CChatGPT%7C1'), 'crm|1|ChatGPT|1');
  assert.equal(initialInput('?receipt=' + encodeURIComponent('https://app.broadcastwell.com/public-fix/broadcastwell')), 'https://app.broadcastwell.com/public-fix/broadcastwell');
  assert.equal(initialInput(''), '');
  assert.equal(initialInput('?other=1'), '');
});

test('a checked input becomes a shareable address, but JSON never goes in the URL', () => {
  assert.equal(shareableSearch('crm|1|ChatGPT|1'), '?record=crm%7C1%7CChatGPT%7C1');
  assert.equal(shareableSearch('https://app.broadcastwell.com/public-fix/broadcastwell'), '?receipt=' + encodeURIComponent('https://app.broadcastwell.com/public-fix/broadcastwell'));
  assert.equal(shareableSearch('{"record_id":"crm|1|ChatGPT|1"}'), '');
  assert.equal(initialInput(shareableSearch('construction-project-management|q1|Google AI Mode|1')), 'construction-project-management|q1|Google AI Mode|1');
});

test('the page has one h1, labelled input, one filled button and no outside scripts or fonts', () => {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1);
  assert.match(html, /<label for="receipt-input">/);
  assert.match(html, /<textarea id="receipt-input"/);
  assert.equal((html.match(/class="primary"/g) || []).length, 1);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<script type="module" src="web\/app\.js"><\/script>/);
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const target = match[1];
    const allowed = !/^https?:/.test(target) || /^https:\/\/(doi\.org|github\.com)\//.test(target);
    assert.ok(allowed || target.startsWith('mailto:'), 'outside resource ' + target);
  }
  assert.ok(!/@import|@font-face|url\(/.test(css), 'no outside fonts or images in the stylesheet');
  assert.match(css, /min-height: 44px/);
  assert.match(css, /:focus-visible/);
});
