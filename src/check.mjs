#!/usr/bin/env node
/**
 * did-it-upload — check whether a web tool sends your file anywhere.
 *
 *   node src/check.mjs --selftest
 *   node src/check.mjs <url> --recipe ./recipes/example.mjs
 *   node src/check.mjs <url> --recipe ./recipes/example.mjs --json
 *
 * The three controls run before every check, and a check is refused if they fail. An instrument that
 * cannot detect a file being uploaded is in no position to tell you that one was not, and the two
 * outcomes look identical in the output.
 *
 * Exit codes:  0 a finding was produced   1 the instrument failed its own controls   2 no finding
 * possible, because the tool could not be confirmed to have run, or the page was blocked.
 */
import { chromium } from 'playwright';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

import { buildTestPdf, makeMarker, probe } from './watch.mjs';
import { runSelfTest } from './selftest.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const value = (name) => {
  const at = argv.indexOf(`--${name}`);
  return at >= 0 ? argv[at + 1] : null;
};

const target = argv.find((a) => !a.startsWith('--') && /^https?:\/\//.test(a));

if (flag('help') || (!target && !flag('selftest'))) {
  console.log(`
  did-it-upload

    node src/check.mjs --selftest                        prove the instrument works
    node src/check.mjs <url> --recipe <file>             check a tool
    node src/check.mjs <url> --recipe <file> --json      machine readable output
    node src/check.mjs <url> --recipe <file> --no-controls

  A recipe is a module with a default export:

    export default {
      act: async (page, file) => { ... },     // put the file in and start the job
      confirm: async (page, { uploads }) => ({ ok: true, evidence: '...' }),   // optional
    };
`);
  process.exit(flag('help') ? 0 : 2);
}

/* ------------------------------------------------------------------ */
/* Controls first, always                                              */
/* ------------------------------------------------------------------ */
if (!flag('no-controls')) {
  console.log('Running the controls before checking anything.\n');
  const failures = await runSelfTest();
  if (failures > 0) {
    console.error(
      `\nREFUSING TO REPORT: ${failures} control(s) failed. The instrument is not trustworthy, so it`,
    );
    console.error('has nothing useful to say about this or any other tool.');
    process.exit(1);
  }
  console.log('\nControls passed. The instrument can see an upload, and does not invent one.\n');
}

if (flag('selftest')) process.exit(0);

/* ------------------------------------------------------------------ */
/* The check                                                           */
/* ------------------------------------------------------------------ */
const recipePath = value('recipe');
if (!recipePath) {
  console.error('  a --recipe is required. See --help for the shape.');
  process.exit(2);
}

const recipeUrl = pathToFileURL(resolve(recipePath)).href;
let recipe;
try {
  recipe = (await import(recipeUrl)).default;
} catch (error) {
  console.error(`  could not load the recipe at ${recipePath}: ${error.message}`);
  process.exit(2);
}
if (!recipe || typeof recipe.act !== 'function') {
  console.error('  the recipe must have a default export with an act(page, file) function.');
  process.exit(2);
}

const marker = makeMarker();
const workDir = await mkdtemp(join(tmpdir(), 'upload-check-'));
const pdfPath = join(workDir, 'probe.pdf');
await writeFile(pdfPath, buildTestPdf(marker));

const settleMs = Number(value('settle') ?? 4_000);
const browser = await chromium.launch({ headless: true });

/*
  THE DEFAULT USER AGENT IS A BROWSER, AND THAT IS A MEASUREMENT DECISION RATHER THAN A TRICK.

  The question this tool answers is "what happens when I use this tool", so it has to make the request a
  person's browser makes. It was written with an honest bot agent first, and on a Cloudflare protected site
  that produced INCONCLUSIVE every time: the challenge never resolved, the tool never ran, and no finding was
  possible. The same page, with a normal browser agent, produced a download and a real answer.

  What it does NOT do is solve or skip a challenge. If a page challenges it anyway, the result is BLOCKED or
  INCONCLUSIVE, and never a clean bill of health. The README asks you to run this against tools you own or
  have permission to test, and that is the line that makes the browser agent fair.
*/
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

const context = await browser.newContext({
  userAgent: value('ua') ?? USER_AGENT,
  acceptDownloads: true,
});

let result;
try {
  result = await probe(context, { url: target, act: recipe.act, confirm: recipe.confirm }, pdfPath, marker, {
    settleMs,
  });
} finally {
  await context.close();
  await browser.close();
}

/* ------------------------------------------------------------------ */
/* What we can and cannot say                                          */
/* ------------------------------------------------------------------ */
const verdict = result.uploadsObserved
  ? 'UPLOADED'
  : result.challengeDetected
    ? 'BLOCKED'
    : result.confirmed
      ? 'NOT OBSERVED'
      : 'INCONCLUSIVE';

const host = result.uploads[0]?.host ?? null;

const summary = {
  UPLOADED: `Your file left the browser. A request carrying it went to ${host}.`,
  'NOT OBSERVED': `The test file did not leave the browser, and the tool demonstrably ran.`,
  INCONCLUSIVE: `Nothing was observed leaving the browser, but nothing confirms the tool ran either,
so this proves nothing. The recipe most likely did not drive the tool.`,
  BLOCKED: `The page showed a bot protection challenge, so it could not be tested.`,
}[verdict];

if (flag('json')) {
  console.log(
    JSON.stringify(
      { verdict, summary, target, marker, host, confirmed: result.confirmed, confirmEvidence: result.confirmEvidence, downloads: result.downloads, uploads: result.uploads, postRequests: result.postRequests, error: result.error, pageTitle: result.pageTitle },
      null,
      2,
    ),
  );
} else {
  console.log(`${verdict}\n`);
  console.log(`  ${summary.replace(/\s+/g, ' ')}`);
  if (result.confirmEvidence) console.log(`\n  Ran because: ${result.confirmEvidence}`);
  if (result.error) console.log(`\n  Error: ${result.error}`);
  if (result.challengeDetected) console.log(`\n  Page title: ${result.pageTitle}`);
  console.log(`\n  File used: probe.pdf, containing the marker ${marker}`);
  console.log(`  Requests with a body that we saw: ${result.postRequests.length}`);
  for (const request of result.uploads) {
    console.log(
      `\n  ${request.method} ${request.url}\n` +
        `    multipart=${request.isMultipart} fileParts=${request.fileParts} ` +
        `markerFound=${request.containsMarker} bytes=${request.bytes}`,
    );
  }
  if (!result.uploadsObserved && result.postRequests.length) {
    console.log('\n  Bodies we saw, none of which carried the file:');
    for (const request of result.postRequests) {
      console.log(
        `    ${request.method} ${request.url} (markerFound=${request.containsMarker}, fileParts=${request.fileParts})`,
      );
    }
  }
  console.log(
    '\n  This is what was observed on one run, on one surface, at one moment. A clean result means\n' +
      '  the test file was not seen leaving the browser on the path this recipe exercised. It is not\n' +
      '  a statement that the tool never uploads anything.',
  );
}

process.exit(verdict === 'UPLOADED' || verdict === 'NOT OBSERVED' ? 0 : 2);
