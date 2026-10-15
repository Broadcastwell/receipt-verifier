# Broadcastwell receipt verifier

<!-- DOI badge: added after the v1.0.0 release is archived -->

We publish receipts for what AI answer engines say: which answer, to which question, on which engine, when it was captured, and a SHA-256 hash of the full answer text. This tool checks a receipt against the published dataset and the public sources it names, so anyone can test one of our claims without trusting us.

It is a small library with no dependencies, a command line and a browser page. It only reads public sources. It never asks an answer engine anything, never measures anything and never needs a key.

This repository contains no engine code: no prompts, no question bank, no measurement or classification logic.

## Run it

### Command line

With Node 20.10 or later:

```sh
npx github:Broadcastwell/receipt-verifier "crm|1|ChatGPT|1"
```

```text
Broadcastwell receipt verifier 1.0.0
Checking an Index receipt: crm|1|ChatGPT|1

PASS           record: found at bytes 946452 to 949860 of answers-2026-09.jsonl (read by byte range); its category, question, engine and run match the record id
PASS           hash: SHA-256 of the published answer text is 2d40a97f6175ba3515a7abc083279f12c18931cb9937ea3b7c8b48a81d1dc782, as the receipt states
PASS           excerpt: the excerpt appears in the published answer text once its markdown marks are removed and its spacing collapsed
...
PASS           doi: https://doi.org/10.5281/zenodo.22907695 redirects to https://zenodo.org/doi/10.5281/zenodo.22907695

Verdict: VERIFIED
Verification id: b1e0662c9115439d26a9e4c1e640a839233e44a8e63e1c13b2a5cc3ca52bbdd8
```

The record id needs quotes in a shell, because of the `|` characters. The same command takes every kind of receipt:

```sh
npx github:Broadcastwell/receipt-verifier "construction-project-management|q1|Google AI Mode|1"
npx github:Broadcastwell/receipt-verifier observation-2e0de5c9-6fc7-4dd2-91d8-aca4e44e8d0f
npx github:Broadcastwell/receipt-verifier https://app.broadcastwell.com/public-fix/broadcastwell
npx github:Broadcastwell/receipt-verifier "https://app.broadcastwell.com/s/<64 hex>?verify=<hash>"
npx github:Broadcastwell/receipt-verifier receipt.json
```

Options:

```text
--json          print the report as JSON
--full          download the whole answers file once into ~/.cache/receipt-verifier
                (or RV_CACHE_DIR), check its SHA-256 against SHA256SUMS.txt, then read the record from it
--timeout <ms>  per request time limit (default 15000)
--help, --version
```

The command prints one line per check, then the verdict and the verification id. It exits with 0 when the receipt is VERIFIED, 1 when it is FAILED, and 2 when it is INCOMPLETE or the input is not a receipt.

### Browser

Open https://broadcastwell.github.io/receipt-verifier/ and paste a record id, a receipt link or a receipt JSON. A link can start the check: `?record=crm%7C1%7CChatGPT%7C1` or `?receipt=<receipt URL>`. The page runs the same library in your browser, keeps nothing and sends no data of yours anywhere; it only reads the public sources each result lists.

### Library

The library is plain JavaScript modules with no dependencies. It runs unchanged in Node 20.10 and later, in current browsers and in Cloudflare Workers, using only `fetch`, `crypto.subtle`, `TextEncoder`, `TextDecoder` and `URL`. It imports its two small data files as JSON modules (`with { type: 'json' }`).

```js
import { verify } from 'receipt-verifier'; // or './src/index.js'

const report = await verify('crm|1|ChatGPT|1');
report.verdict;          // 'VERIFIED', 'FAILED' or 'INCOMPLETE'
report.checks;           // [{ id, status, reason }] in a fixed order
report.verification_id;  // the same for the same receipt and the same sources
```

`verify(input, options)` takes a record id, a receipt URL, a receipt JSON string or a receipt object. The options are `fetch` (a fetch to use instead of the global one), `full` (read the whole answers file and check its SHA-256), `offsets` (a locator to use instead of the bundled one) and `timeoutMs` (per request, default 15000). An input that is not a receipt throws an `InputError` with a plain message. The report shape is in `schema/report.schema.json`; the receipt shapes are in `schema/receipt.schema.json`.

## What it accepts

1. An Index record id: `<category id>|<question id>|<engine>|<run>`, for example `crm|1|ChatGPT|1` or `construction-project-management|q1|Google AI Mode|1`. The tool looks for the receipt the public API publishes for that record. If the API publishes none, the receipt is the dataset record itself.
2. A receipt URL: any URL with `record=<record id>` or `#<record id>`; a Decision Receipt link `https://app.broadcastwell.com/s/<64 hex>`, with or without `?verify=<hash>`; a Public Fix link ending in `/public-fix/<slug>`; any URL naming an `observation-<uuid>`.
3. A sample id: `sample:observation-<uuid>` or a bare `observation-<uuid>`.
4. A receipt JSON in any of the three shapes below. A JSON receipt is checked as given: each of its own fields is compared with the source. That is how a changed receipt is caught.

## The checks

Every check answers PASS, FAIL or NOT CHECKABLE with a plain reason. A source that cannot be read (offline, blocked by the browser, too slow) is NOT CHECKABLE with the reason "the source could not be read from here; try the command line". It is never a FAIL: only a published source that disagrees with the receipt is a FAIL.

**record.** The record exists at its public source. For an Index receipt, the tool reads that one line of `answers-2026-09.jsonl` from Zenodo by HTTP byte range, using the locator in `data/`, and confirms the line's own category, question, engine and run equal the record id before it trusts anything in it. For a sample receipt, the observation is in the sample export. For a Decision Receipt, the share link answers for a stored run.

**hash.** The SHA-256 of the full answer text as published equals the hash on the receipt. For an Index receipt this is a real recomputation from the published answer text. For a sample receipt, it is the SHA-256 of the full answer in the export. For a Decision Receipt, see the limits below.

**excerpt.** The excerpt, without its leading `... ` and trailing ` ...`, is a substring of the answer text once its markdown marks are removed and its spacing is collapsed, by the same rule the Index uses to cut excerpts.

**cited_pages.** Every page the receipt lists as cited is among the pages the published answer cites.

**engine.** The engine on the receipt is the engine of the published record: ChatGPT, Claude, Perplexity, Google AI Overviews or Google AI Mode.

**question.** The question text on the receipt equals the question as the Index published it for that question id: from the public API first, then from `release-2026-09.json` in the Zenodo record, and from `control-questions.json` for a control question.

**run.** The run on the receipt is the repeat of the published record (1 to 3), or for the sample the run and pass the export names.

**captured_at.** The capture time on the receipt is the published capture time, character for character.

**doi.** `https://doi.org/10.5281/zenodo.22907695` redirects to the Zenodo record. Where the redirect cannot be read (a browser hides it), the tool reads the Zenodo record and compares its DOI field instead.

**Verdict.** VERIFIED when record and hash pass and nothing fails. FAILED when any check fails. INCOMPLETE otherwise.

**Verification id.** The SHA-256 of the canonical JSON (keys sorted, no whitespace) of the verifier name and version, the receipt kind, the receipt as checked, each check's id and status, the verdict and the dataset identity. The time of the check is not part of it, so the same receipt checked against the same sources always gets the same id, on any machine. The report also carries `checked_at` and the list of sources it read.

## The three receipt kinds

**Index receipt.** One answer from the Absence Index, release 2026-09: `record_id`, `engine`, `question`, `run`, `captured_at`, `excerpt`, `cited_urls` (up to three) and `answer_sha256`. The public API serves them at `https://app.broadcastwell.com/api/v1/index/categories/<category>`. The published dataset holds the full answer text, so every field can be checked.

**Sample receipt.** One answer from the sample run of Kalvenor Systems, a fictional company; every answer in it is illustrative. Fields: `receipt_id`, `run_id`, `pass_id`, `question_id`, `question_text`, `engine`, `engine_label`, `cited_urls`, `answer_text` and `observed_at`. The tool reads the keyless sample export at `https://app.broadcastwell.com/api/export/kalvenor-monitor.json`.

**Decision Receipt.** A shared run, such as day 0 of a Public Fix: a read-only share link `https://app.broadcastwell.com/s/<token>` that prints a run-level SHA-256 over all the run's stored receipts in a fixed order and field order, and verifies itself with `?verify=<hash>`. As JSON: `receipts_url` and `hash`, optionally `run_id` and `receipts`.

## Honest limits

- For a Decision Receipt, the hash check is "the hash matches the published hash, recomputed by the app from the stored receipts". The answer texts of client runs and Public Fix runs are not public, so the tool cannot recompute that hash itself, and the excerpt and cited-page checks are NOT CHECKABLE there. The engine, question and capture time are NOT CHECKABLE too, because the receipt covers a whole run.
- The sample is fictional and has no DOI; its DOI check is NOT CHECKABLE with that reason.
- By default the tool reads one record by byte range and does not hash the whole 9 MB file. The full option downloads the file once, checks its SHA-256 against `SHA256SUMS.txt` in the Zenodo record and against the pinned value, and only then reads the record.
- A browser can read only the sources that allow it. The public API and Zenodo do; the sample export and the share links do not, so in the browser those checks are NOT CHECKABLE. The command line reads all of them.
- When the public API publishes no receipt for a record, the receipt is the dataset record itself: its hash is computed from the dataset, and the excerpt check is NOT CHECKABLE with the reason "no published excerpt for this record".
- VERIFIED means the receipt matches its published source. It says nothing about whether an engine's answer is right, and it is not a measurement.

## Data sources and licences

- **The Absence Index dataset**, release 2026-09, CC BY 4.0, DOI [10.5281/zenodo.22907695](https://doi.org/10.5281/zenodo.22907695), record https://zenodo.org/records/22907695. The answers file `answers-2026-09.jsonl` has 2,250 lines, 9,028,293 bytes and SHA-256 `221c94e1ebad2bc87d7cd20837fa670cc40b10dba6f68b75423dc8bee69697b3`, equal to its line in the record's `SHA256SUMS.txt`.
- **The public API** at app.broadcastwell.com: the Index category endpoint, the Public Fix record and the share links. Keyless and read only.
- **The sample export**, keyless, for the fictional Kalvenor Systems.
- `data/answers-2026-09.offsets.json` holds, for each record id, where its line starts in the answers file and how long it is. `data/release-2026-09.meta.json` holds the record's file names, sizes, SHA-256 values, DOI and URL. Both are generated from the dataset by `scripts/build-offsets.mjs`, which stops unless the file's SHA-256 equals the pinned value and its line in `SHA256SUMS.txt`. They hold no answer or question text.
- `test/fixtures/` holds copies of public data for the offline tests, fetched once by `scripts/fetch-fixtures.mjs`. The answer text and excerpts there are quoted exactly as published (CC BY 4.0, Broadcastwell); the sample is fictional.
- The tool itself is under the MIT licence. Copyright 2026 Broadcastwell LLC.

## Development

```sh
npm test                    # offline: every source is served from test/fixtures
RV_LIVE=1 npm test          # also runs test/live.test.js against the live sources
node scripts/build-offsets.mjs
node scripts/fetch-fixtures.mjs
```

The tests also hold the library to its own rules: ASCII only, no Node-only APIs in `src/`, no dependencies, nothing that looks like a key. `test/LIVE_RUN.txt` keeps the output of one live run, and `proof/` keeps the command line output on real receipts.

To cite the tool, see `CITATION.cff`.

## Contact

hello@broadcastwell.com
