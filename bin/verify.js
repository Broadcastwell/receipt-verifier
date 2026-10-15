#!/usr/bin/env node
// receipt-verifier: checks a Broadcastwell receipt against the published dataset and the public API.
//
//   receipt-verifier <record id | receipt URL | receipt.json> [options]
//
// Options (see USAGE below): json output, the full check, a per request timeout.
// Exit codes: 0 VERIFIED, 1 FAILED, 2 INCOMPLETE or an input error.

import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FLAG = '-'.repeat(2);
const USAGE = [
  'Usage: receipt-verifier <record id | receipt URL | receipt.json> [options]',
  '',
  'Checks a Broadcastwell receipt against the published dataset and the public API.',
  '',
  'Examples:',
  '  receipt-verifier "crm|1|ChatGPT|1"',
  '  receipt-verifier observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f',
  '  receipt-verifier https://app.broadcastwell.com/public-fix/broadcastwell',
  '  receipt-verifier receipt.json',
  '',
  'Options:',
  '  ' + FLAG + 'json          print the report as JSON',
  '  ' + FLAG + 'full          read the whole answers file once (cached under your home folder),',
  '                  check its SHA-256 against SHA256SUMS.txt, then read the record from it',
  '  ' + FLAG + 'timeout <ms>  per request time limit (default 15000)',
  '  ' + FLAG + 'help          show this help',
  '  ' + FLAG + 'version       show the version',
  '',
  'Exit codes: 0 VERIFIED, 1 FAILED, 2 INCOMPLETE or an input error.'
].join('\n');

const EXIT = { VERIFIED: 0, FAILED: 1, INCOMPLETE: 2 };
const BOM = 0xfeff;
const STATUS_WIDTH = 'NOT CHECKABLE'.length;

export function parseArgs(argv) {
  const options = { input: null, json: false, full: false, timeoutMs: undefined, help: false, version: false, error: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === FLAG + 'json' || arg === '-j') options.json = true;
    else if (arg === FLAG + 'full' || arg === '-f') options.full = true;
    else if (arg === FLAG + 'help' || arg === '-h') options.help = true;
    else if (arg === FLAG + 'version' || arg === '-v') options.version = true;
    else if (arg === FLAG + 'timeout' || arg.startsWith(FLAG + 'timeout=')) {
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[(index += 1)];
      const ms = Number(value);
      if (!Number.isInteger(ms) || ms <= 0) options.error = 'the timeout is a whole number of milliseconds';
      else options.timeoutMs = ms;
    } else if (arg.startsWith('-') && arg.length > 1) {
      options.error = 'unknown option ' + arg;
    } else if (options.input === null) {
      options.input = arg;
    } else {
      options.error = 'give one receipt at a time';
    }
  }
  return options;
}

// Reasons quote receipt fields, and a receipt file may carry newlines or terminal escape codes. Every
// control character becomes a space, so no receipt can forge or hide a line of the output.
export function printable(value) {
  let out = '';
  for (const char of String(value)) {
    const code = char.codePointAt(0);
    out += code < 32 || (code >= 127 && code <= 159) ? ' ' : char;
  }
  return out;
}

export function formatReport(report) {
  const lines = [];
  lines.push('Broadcastwell receipt verifier ' + report.verifier.version);
  lines.push('Checking ' + describe(report) + ': ' + report.subject);
  lines.push('');
  for (const check of report.checks) {
    lines.push(check.status.padEnd(STATUS_WIDTH) + '  ' + check.id + ': ' + check.reason);
  }
  lines.push('');
  lines.push('Verdict: ' + report.verdict);
  lines.push('Verification id: ' + report.verification_id);
  lines.push('Checked at: ' + report.checked_at);
  lines.push('Sources read:');
  for (const source of report.sources) lines.push('  ' + source);
  return lines.map(printable).join('\n') + '\n';
}

function describe(report) {
  if (report.kind === 'index') return 'an Index receipt';
  if (report.kind === 'sample') return 'a sample receipt (fictional company)';
  return 'a Decision Receipt';
}

export function exitCodeFor(report) {
  return Object.prototype.hasOwnProperty.call(EXIT, report.verdict) ? EXIT[report.verdict] : 2;
}

export function cacheDir() {
  return process.env.RV_CACHE_DIR || join(homedir(), '.cache', 'receipt-verifier');
}

function hasRange(headers) {
  if (!headers) return false;
  if (typeof headers.get === 'function') return headers.get('range') !== null;
  return Object.keys(headers).some(key => key.toLowerCase() === 'range');
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// For the full check: the answers file is downloaded once into the cache folder and checked against
// SHA256SUMS.txt before it is used; a cached copy that no longer matches is downloaded again.
export function cachingFetch(sources, dir, realFetch = globalThis.fetch, log = () => {}) {
  let pending = null;
  const ensure = async (init) => {
    const file = join(dir, sources.ANSWERS_FILE);
    const pass = { headers: init && init.headers, signal: init && init.signal };
    const sums = await realFetch(sources.SUMS_URL, pass);
    if (!sums.ok) throw new Error(sources.SUMS_FILE + ' answered ' + sums.status);
    const expected = sources.parseSums(await sums.text()).get(sources.ANSWERS_FILE);
    if (!expected) throw new Error(sources.SUMS_FILE + ' has no line for ' + sources.ANSWERS_FILE);
    if (existsSync(file)) {
      const cached = await readFile(file);
      if (sha256(cached) === expected) {
        log('Using the cached ' + sources.ANSWERS_FILE + ' in ' + dir + ' (its SHA-256 equals ' + sources.SUMS_FILE + ')');
        return cached;
      }
      log('The cached ' + sources.ANSWERS_FILE + ' does not match ' + sources.SUMS_FILE + '; downloading it again');
    }
    log('Downloading ' + sources.ANSWERS_FILE + ' (about 9 MB) once into ' + dir);
    const response = await realFetch(sources.ANSWERS_URL, pass);
    if (!response.ok) throw new Error(sources.ANSWERS_FILE + ' answered ' + response.status);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== expected) throw new Error('the downloaded ' + sources.ANSWERS_FILE + ' does not match ' + sources.SUMS_FILE);
    try {
      await mkdir(dir, { recursive: true });
      const partial = file + '.part';
      await writeFile(partial, bytes);
      await rename(partial, file);
    } catch (error) {
      log('The verified file could not be cached in ' + dir + ' (' + error.message + '); it is used without caching');
    }
    return bytes;
  };
  const guarded = async (init) => {
    try {
      return await ensure(init);
    } catch (error) {
      log('Full check: ' + error.message);
      throw error;
    }
  };
  return async (url, init) => {
    if (String(url) === sources.ANSWERS_URL && !hasRange(init && init.headers)) {
      pending = pending || guarded(init);
      const bytes = await pending;
      return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
    }
    return realFetch(url, init);
  };
}

async function readInput(text) {
  if (/\.json$/i.test(text) && !/^https?:/i.test(text)) {
    if (!existsSync(text)) throw Object.assign(new Error('no such file: ' + text), { input: true });
    const raw = await readFile(text, 'utf8');
    try {
      return JSON.parse(raw.charCodeAt(0) === BOM ? raw.slice(1) : raw);
    } catch (error) {
      throw Object.assign(new Error(text + ' is not valid JSON'), { input: true });
    }
  }
  return text;
}

// Node 20 and 22 announce JSON modules as experimental; the library imports two small JSON files.
function quietJsonModuleWarning() {
  const emit = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (/JSON modules/i.test(text) || /Import attributes/i.test(text)) return undefined;
    return emit.call(process, warning, ...rest);
  };
}

export async function main(argv = process.argv.slice(2), io = { out: process.stdout, err: process.stderr }) {
  const args = parseArgs(argv);
  if (args.help) {
    io.out.write(USAGE + '\n');
    return 0;
  }
  quietJsonModuleWarning();
  let library;
  try {
    library = await import('../src/index.js');
  } catch (error) {
    io.err.write('receipt-verifier: the library could not load on Node ' + process.version + ' (Node 20.10 or later is needed): ' + error.message + '\n');
    return 2;
  }
  if (args.version) {
    io.out.write(library.VERSION + '\n');
    return 0;
  }
  if (args.error || !args.input) {
    io.err.write('receipt-verifier: ' + (args.error || 'give a record id, a receipt URL or a receipt JSON file') + '\n\n' + USAGE + '\n');
    return 2;
  }
  let report;
  try {
    const input = await readInput(args.input);
    const options = { timeoutMs: args.timeoutMs, full: args.full };
    if (args.full) {
      const sources = await import('../src/sources.js');
      options.fetch = cachingFetch(sources, cacheDir(), globalThis.fetch, line => io.err.write(line + '\n'));
    }
    report = await library.verify(input, options);
  } catch (error) {
    const known = error && (error.input || error.name === 'InputError');
    io.err.write('receipt-verifier: ' + (known ? error.message : 'could not check this receipt: ' + (error && error.message ? error.message : String(error))) + '\n');
    return 2;
  }
  io.out.write(args.json ? JSON.stringify(report, null, 2) + '\n' : formatReport(report));
  return exitCodeFor(report);
}

// Runs when started as a command (directly, without the .js extension, through npx or a linked bin),
// not when imported by the tests.
function isEntry() {
  const started = process.argv[1];
  if (!started) return false;
  let self;
  try {
    self = realpathSync(fileURLToPath(import.meta.url));
  } catch (error) {
    return false;
  }
  for (const candidate of [started, started + '.js']) {
    try {
      if (realpathSync(candidate) === self) return true;
    } catch (error) {
      // not this candidate
    }
  }
  return false;
}

if (isEntry()) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      process.stderr.write('receipt-verifier: ' + (error && error.message ? error.message : String(error)) + '\n');
      process.exitCode = 2;
    });
}
