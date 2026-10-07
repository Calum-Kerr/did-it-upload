/**
 * Prove the instrument works before believing anything it says.
 *
 * WHY THIS FILE EXISTS, AND WHY IT HAS THREE CONTROLS
 *
 * A detector that reports "no upload observed" is indistinguishable from a detector that is simply
 * broken. Both produce the same output, and one of them would put a false clean bill of health on
 * every tool it was pointed at. That is not hypothetical: three separate faults were found by these
 * controls while the instrument was being built, and all three failed silently.
 *
 *   positive      a page that uploads the file       must be DETECTED
 *   negative      a page that keeps the file         must NOT be detected
 *   specificity   a text only multipart post         must NOT be detected
 *
 * The specificity control is the one people leave out. Without it, "we saw a multipart POST" is
 * treated as "we saw a file", and every tool that posts a form is accused of uploading your document.
 *
 * The fixtures are served from a loopback server started here, so the whole test runs offline, in
 * about ten seconds, against nothing but itself.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildTestPdf, makeMarker, probe } from './watch.mjs';

function fixturePage(mode) {
  const action = {
    file: `const fd = new FormData();
           fd.append('file', f, 'probe.pdf');
           await fetch('/upload', { method: 'POST', body: fd });`,
    text: `const fd = new FormData();
           fd.append('note', 'no file here at all');
           await fetch('/upload', { method: 'POST', body: fd });`,
    none: `document.title = 'handled locally';`,
  }[mode];

  return `<!doctype html><html><body>
    <input type="file" id="f">
    <button id="go">Go</button>
    <script>
      document.getElementById('go').onclick = async () => {
        const f = document.getElementById('f').files[0];
        if (!f) return;
        ${action}
      };
    </script>
  </body></html>`;
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/upload') {
        req.resume();
        req.on('end', () => {
          res.writeHead(204);
          res.end();
        });
        return;
      }

      const mode = req.url.startsWith('/text-only')
        ? 'text'
        : req.url.startsWith('/local')
          ? 'none'
          : 'file';

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(fixturePage(mode));
    });

    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function describe(request, index) {
  return (
    `        [${index}] ${request.method} ${request.url}\n` +
    `            multipart=${request.isMultipart} fileParts=${request.fileParts} ` +
    `markerFound=${request.containsMarker} bytes=${request.bytes} entrySizes=[${request.entrySizes}]`
  );
}

/**
 * Run the three controls.
 *
 * Returns the number of failures. A caller that gets anything above zero must publish nothing, because
 * an instrument that fails its own controls has no opinion worth recording.
 */
export async function runSelfTest({ quiet = false } = {}) {
  const say = (line) => {
    if (!quiet) console.log(line);
  };

  const marker = makeMarker();
  const workDir = await mkdtemp(join(tmpdir(), 'upload-check-'));
  const pdfPath = join(workDir, 'probe.pdf');
  await writeFile(pdfPath, buildTestPdf(marker));

  const browser = await chromium.launch({ headless: true });
  const { server, port } = await startFixtureServer();
  const context = await browser.newContext();
  const base = `http://127.0.0.1:${port}`;
  const act = async (page, file) => {
    await page.locator('#f').setInputFiles(file);
    await page.locator('#go').click();
    await page.waitForTimeout(900);
  };
  const report = (result) =>
    result.postRequests.map(describe).join('\n') || '        (no POST requests at all)';

  let failures = 0;

  try {
    say('1/3 positive control: a page that uploads a file. Must be DETECTED.');
    const positive = await probe(context, { url: `${base}/upload-fixture`, act }, pdfPath, marker);
    if (positive.uploadsObserved) {
      say(`  PASS  file upload detected via ${positive.uploads[0]?.host}`);
    } else {
      say('  FAIL  file upload NOT detected:');
      say(report(positive));
      failures += 1;
    }

    say('\n2/3 negative control: a page that keeps the file. Must NOT be detected.');
    const negative = await probe(context, { url: `${base}/local`, act }, pdfPath, marker);
    if (!negative.uploadsObserved) {
      say('  PASS  no upload reported, as expected');
    } else {
      say('  FAIL  false positive: reported an upload that never happened.');
      say(report(negative));
      failures += 1;
    }

    say('\n3/3 specificity control: a multipart post with no file. Must NOT be detected.');
    const specificity = await probe(
      context,
      { url: `${base}/text-only-fixture`, act },
      pdfPath,
      marker,
    );
    if (!specificity.uploadsObserved) {
      say('  PASS  correctly ignored a text only multipart post');
    } else {
      say('  FAIL  false positive: treated a text only form post as a file upload.');
      say(report(specificity));
      failures += 1;
    }
  } finally {
    await context.close();
    server.close();
    await browser.close();
  }

  return failures;
}
