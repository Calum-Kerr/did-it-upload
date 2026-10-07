/**
 * The instrument.
 *
 * Answers one question: when you hand a web tool a file, do the file's bytes leave your device?
 *
 * The method is deliberately blunt, because blunt is checkable:
 *   1. Build a PDF containing a unique random marker string.
 *   2. Watch every outbound request the browser makes.
 *   3. Look for the marker inside any request body, and for a multipart body carrying a file part.
 *
 * If either appears, the file left the device. That is an observation rather than an inference, and
 * anyone can repeat it.
 *
 * WHY THIS USES THE CHROME DEVTOOLS PROTOCOL
 *
 * Three browser limitations had to be worked around, and all three fail silently. Each one looks
 * exactly like "no upload happened", which is the one wrong answer that matters here:
 *
 *   1. Playwright's `request.postDataBuffer()` returns null for multipart form uploads. The POST is
 *      visible, its body is not.
 *   2. CDP's `Network.getRequestPostData` truncates multipart bodies. A 680 byte body arrived as 188
 *      bytes, and the marker sat past the cut, so detection failed while looking like a clean result.
 *   3. Chrome redacts file and Blob parts of a multipart body permanently. That one is not a bug to
 *      work around: it is how the browser behaves, and it will not change.
 *
 * The fix for the first two is the `Fetch` domain, which pauses each request before it is sent, at
 * which point the complete body is readable, then lets it continue.
 *
 * The third cannot be fixed, so it is turned into a signal instead. A multipart body whose parts
 * include an entry with no bytes is a multipart body carrying a file. That is the primary detection
 * method, and it needs its own control to prove it does not fire on ordinary text only form posts.
 * `src/selftest.mjs` holds all three controls.
 *
 * WHAT THIS CANNOT PROVE
 *
 * That nothing is uploaded on some other code path that was never exercised. So a clean result is
 * reported as "we did not observe the test file being sent anywhere", and never as "this tool never
 * uploads". The difference is the whole reason the report is worded the way it is.
 */

import { deflateSync } from 'node:zlib';

/** A uniquely identifiable string to hunt for in request bodies. */
export function makeMarker(prefix = 'UPLOAD-CHECK') {
  const random = Math.random().toString(36).slice(2, 10).toUpperCase();
  return `${prefix}-${random}`;
}

/**
 * Build a small but structurally valid PDF with the marker as its text.
 *
 * Valid matters. A tool that rejects the file will never upload it, and an invalid file would produce
 * a clean result for the wrong reason. This has a correct cross reference table, so a strict parser
 * accepts it.
 */
export function buildTestPdf(marker) {
  const content = `BT /F1 18 Tf 40 200 Td (${marker}) Tj ET`;

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] ' +
      '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];

  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  return Buffer.from(pdf, 'latin1');
}

/**
 * Build a small but structurally valid PNG carrying the marker, for tools that take images.
 *
 * WHY THIS EXISTS. `buildTestPdf` covers PDF tools, which is most of them, but a JPG to PDF converter
 * never sees a PDF. A marked PNG widens this to every tool that takes a picture, and a picture tool is
 * where the no-upload claim matters most: the file people convert is often an identity document.
 *
 * HOW THE MARKER TRAVELS. It sits in a `tEXt` chunk, which is a legitimate part of the format and
 * survives any parser. That gives the test two independent signals rather than one:
 *
 *   1. If the tool sends the file it was handed, the marker is in the request body and we can read it.
 *   2. If the tool re-encodes the image before sending it, the marker is gone, but the body is still a
 *      multipart post carrying a redacted file part, which is the primary signal anyway.
 *
 * The second is why an image test is still worth running without the first. Worth saying plainly in any
 * report: for an image input, detection rests on the file-part signal, because a tool that redraws the
 * picture and then uploads it would defeat a search for our own bytes.
 *
 * The image itself is deliberately simple: a light background with a few dark bars, so it looks like a
 * document rather than noise, and so any tool that renders a preview has something to render.
 */
export function buildTestPng(marker, { width = 96, height = 96 } = {}) {
  const crcTable = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    return table;
  })();

  const crc32 = (buffer) => {
    let c = -1;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };

  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  /* Raw scanlines: one filter byte then RGB triples. Dark bars across a light page. */
  const raw = Buffer.alloc(height * (1 + width * 3), 245);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    raw[rowStart] = 0;
    const inBar = y % 16 < 6;
    if (!inBar) continue;
    for (let x = 10; x < width - 10; x++) {
      const at = rowStart + 1 + x * 3;
      raw[at] = 30;
      raw[at + 1] = 30;
      raw[at + 2] = 30;
    }
  }

  const text = Buffer.concat([Buffer.from('Comment\0', 'latin1'), Buffer.from(marker, 'latin1')]);

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', text),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Watch a page for outbound requests that carry file bodies.
 *
 * Requires a CDP session. Requests are paused before being sent so their full bodies are readable,
 * and every paused request is released immediately, because a request left hanging makes the page
 * hang with it.
 */
export async function watchForUploads(context, page, marker) {
  const markerBytes = Buffer.from(marker, 'latin1');
  const cdp = await context.newCDPSession(page);
  const postRequests = [];

  function record(request) {
    const method = request?.method;
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return;

    let host = null;
    try {
      host = new URL(request.url).host;
    } catch {
      /* not a URL request target */
    }

    const headers = request.headers ?? {};
    const contentType = String(headers['Content-Type'] ?? headers['content-type'] ?? '');

    let body = null;
    let bodySource = 'none';
    let entryCount = 0;
    let entrySizes = [];
    let fileParts = 0;

    /*
      Chrome exposes the text parts of a multipart body and redacts the file and Blob parts, reporting
      them as an entry with no `bytes` field at all. The bytes cannot be read, but the redaction itself
      is the signal: an entry with no bytes, inside a multipart body, is a file part.
    */
    const entries = request.postDataEntries;
    if (Array.isArray(entries) && entries.length > 0) {
      entryCount = entries.length;
      const readable = [];
      for (const part of entries) {
        if (part && typeof part.bytes === 'string' && part.bytes.length > 0) {
          readable.push(Buffer.from(part.bytes, 'base64'));
        } else {
          fileParts += 1;
        }
      }
      entrySizes = readable.map((b) => b.length);
      body = readable.length ? Buffer.concat(readable) : null;
      bodySource = 'fetch-entries';
    } else if (typeof request.postData === 'string' && request.postData.length > 0) {
      body = Buffer.from(request.postData, 'latin1');
      bodySource = 'fetch-postData';
    }

    const isMultipart = contentType.includes('multipart/form-data');
    const containsMarker = body ? body.includes(markerBytes) : false;

    postRequests.push({
      method,
      url: request.url,
      host,
      contentType: contentType.slice(0, 120),
      isMultipart,
      /* Reading the marker is the gold standard. Chrome will not give it up for a file part, so a
         redacted part is the next best evidence. The specificity control is what makes it usable. */
      containsMarker,
      fileParts,
      looksLikeFileUpload: isMultipart && fileParts > 0,
      bytes: body ? body.length : 0,
      bodySource,
      entryCount,
      entrySizes,
      preview: body ? body.subarray(0, 200).toString('latin1').replace(/[^\x20-\x7e]/g, '.') : null,
    });
  }

  /* Primary: pause every request before it is sent. */
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

  cdp.on('Fetch.requestPaused', (event) => {
    try {
      record(event.request);
    } catch {
      /* never let inspection block the request */
    }
    cdp.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
  });

  /* Secondary: catches anything the Fetch domain does not surface. */
  await cdp.send('Network.enable', { maxPostDataSize: 10 * 1024 * 1024 });

  cdp.on('Network.requestWillBeSent', (event) => {
    const request = event.request;
    const method = request?.method;
    if (method !== 'POST' && method !== 'PUT' && method !== 'PATCH') return;
    if (postRequests.some((e) => e.url === request.url && e.method === method)) return;
    record(request);
  });

  return {
    postRequests,
    /** Evidence the file moved: the marker was read, or a multipart body carried a file part. */
    get uploads() {
      return postRequests.filter((entry) => entry.containsMarker || entry.looksLikeFileUpload);
    },
  };
}

/**
 * Open a tool, run its recipe, and report what was observed.
 *
 * A recipe is an object:
 *
 *   {
 *     url:     'https://example.com/merge-pdf',
 *     act:     async (page, file) => { ... },   // get the file in and start the job
 *     confirm: async (page, { uploads }) => ({ ok: true, evidence: '...' })   // optional
 *   }
 *
 * CONFIRMATION IS NOT OPTIONAL IN PRACTICE, even though the field is. Zero uploads means one of two
 * things: the tool ran and kept the file, or the recipe did nothing at all. Those are indistinguishable
 * from the network alone, and only one of them is a finding. A download is the strongest available
 * signal that a PDF tool demonstrably did the work, so it is checked automatically; a recipe can add
 * its own evidence for tools that finish without downloading.
 */
export async function probe(context, target, pdfPath, marker, { settleMs = 4_000 } = {}) {
  const page = await context.newPage();
  const watcher = await watchForUploads(context, page, marker);
  const pageErrors = [];
  const downloads = [];
  page.on('pageerror', (error) => pageErrors.push(String(error?.message ?? error)));
  page.on('download', (download) => downloads.push(download.suggestedFilename()));

  const result = {
    url: target.url,
    navigated: false,
    finalUrl: null,
    acted: false,
    confirmed: null,
    confirmEvidence: null,
    challengeDetected: false,
    challengeScriptSeen: false,
    pageTitle: null,
    downloads: [],
    uploadsObserved: false,
    uploads: [],
    postRequests: [],
    pageErrors,
    error: null,
  };

  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    result.navigated = true;
    result.finalUrl = page.url();

    await target.act(page, pdfPath);
    result.acted = true;

    if (downloads.length === 0) {
      await page.waitForEvent('download', { timeout: 15_000 }).catch(() => {});
    }

    if (typeof target.confirm === 'function') {
      try {
        const confirmation = await target.confirm(page, {
          postRequests: watcher.postRequests,
          uploads: watcher.uploads,
        });
        result.confirmed = Boolean(confirmation?.ok);
        result.confirmEvidence = confirmation?.evidence ?? null;
      } catch (error) {
        result.confirmed = false;
        result.confirmEvidence = `confirmation step failed: ${String(error?.message ?? error)}`;
      }
    }

    if (downloads.length > 0) {
      result.confirmed = true;
      result.confirmEvidence = `The tool produced a file for download (${downloads[0]}), so it demonstrably ran.`;
    }

    result.downloads = downloads;

    /* Give a deferred upload a chance to fire. */
    await page.waitForTimeout(settleMs);
  } catch (error) {
    result.error = `${error?.name ?? 'Error'}: ${String(error?.message ?? error)}`.split('\n')[0];
  }

  /*
    Bot protection detection is deliberately narrow: only a challenge INTERSTITIAL counts as being
    blocked. Cloudflare's challenge script loads in the background on plenty of sites that serve
    requests perfectly well, so seeing that request is not evidence of being blocked. Treating it as
    such produced a false "blocked" verdict on a page that had clearly loaded.
  */
  try {
    result.pageTitle = await page.title();
  } catch {
    /* the page may already be gone */
  }

  result.challengeScriptSeen = watcher.postRequests.some((r) =>
    r.url.includes('/cdn-cgi/challenge-platform'),
  );

  result.challengeDetected =
    /just a moment|checking your browser|attention required|verify you are human|enable javascript and cookies/i.test(
      result.pageTitle ?? '',
    );

  result.postRequests = watcher.postRequests;
  result.uploads = watcher.uploads;
  result.uploadsObserved = watcher.uploads.length > 0;

  await page.close().catch(() => {});
  return result;
}
