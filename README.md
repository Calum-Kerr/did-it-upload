# did-it-upload

**Check whether a web tool sends your file anywhere, by watching the network while it runs.**

Every "free online PDF tool" opens with the same box: drop your file here. What happens next is invisible.
Maybe it converts the file in your browser. Maybe it uploads it to a server, keeps a copy, and adds it to
something. From the outside those look identical, and the polite privacy policy is not evidence either way.

This drives the tool in a real browser with a file that says who it is, and records every request. If the
file leaves your machine, you get the request that carried it.

```
UPLOADED

  Your file left the browser. A request carrying it went to pdf.example.com.

  Ran because: The tool produced a file for download (out.pdf), so it demonstrably ran.

  File used: probe.pdf, containing the marker UPLOAD-CHECK-8KQ2ZP1A
  Requests with a body that we saw: 1

  POST https://pdf.example.com/api/convert
    multipart=true fileParts=1 markerFound=false bytes=0
```

## Run it

```
npm install
npx playwright install chromium

npm run selftest                                                  # prove the instrument works
node src/check.mjs https://example.com/merge-pdf --recipe ./recipes/example.mjs
```

A recipe is ten lines that tell it how to drive one site: find the file input, set the file, click the
button. Copy `recipes/example.mjs` and change the selectors. There is no way around one recipe per tool,
which is the reason this did not already exist.

## Why you can trust the answer

A detector that reports "no upload" is indistinguishable from a detector that is broken. Both print the same
thing, and one of them tells you a lie about your confidential document. So before every check, three
controls run against fixtures on your own machine:

| Control | Fixture | Must be |
|---|---|---|
| positive | a page that uploads the file | **detected** |
| negative | a page that keeps the file | not detected |
| specificity | a page that posts a form with no file | not detected |

If any control fails, the check refuses to report. `npm run selftest` runs them on their own.

The specificity control is the one people leave out, and without it "we saw a multipart POST" quietly
becomes "we saw your file", which would accuse every tool that submits a form.

## What was hard about this

Three browser behaviours had to be worked around, and all three fail silently, each looking exactly like a
clean result:

1. **Playwright's `request.postDataBuffer()` returns null for multipart uploads.** The POST is visible, its
   body is not.
2. **Chrome DevTools truncates multipart bodies.** A 680 byte body arrived as 188 bytes. The marker sat past
   the cut, so detection failed and looked like success.
3. **Chrome redacts file parts entirely.** This one is not a bug that can be worked around. A file part
   arrives as an entry with no bytes field at all.

The first two are solved with the `Fetch` domain, which pauses each request before it is sent, when the whole
body is still readable, then releases it. The third is turned into the signal: a multipart body containing an
entry with no bytes is a multipart body carrying a file. That is what the specificity control exists to
police.

## What it cannot tell you

**This is one run, on one surface, at one moment.** A clean result means the test file was not seen leaving
the browser on the path the recipe exercised. It does not mean the tool never uploads anything, and the
output is worded that way on purpose.

**If the tool cannot be confirmed to have run, the answer is INCONCLUSIVE, not clean.** A recipe that clicks
the wrong button and a tool that works entirely offline both produce zero uploads. Only one of them is worth
publishing, so a download, or the recipe's own confirmation, has to say the tool finished before any clean
result is given.

**Bot protection will stop it.** A challenge page is reported as BLOCKED rather than as a pass.

It identifies as an ordinary browser, and that is a measurement decision rather than a trick: the question is
what happens when *you* use the tool, so it has to make the request your browser makes. The first version
identified honestly as a bot, and on a Cloudflare protected site that meant a challenge that never resolved,
the tool never ran, and every result was INCONCLUSIVE. It does not solve or skip challenges. If a page blocks
it anyway, that is reported, and never as a pass.

## Use it on tools you are allowed to test

This drives a real site with a real request, so:

- test your own tools, or copies you run yourself;
- ask before pointing it at somebody else's production service, and do not run it on a schedule against one;
- the test file contains one sentence and a random marker, and nothing else.

That is not legal advice, it is just the decent way to use a tool like this.

## Contributing

The instrument is done; what is missing is recipes and fixtures.

- **Recipes** for tools you care about, especially self hosted ones. One small file each.
- **Fixtures other than PDF.** `buildTestPdf` makes a marked PDF. A marked PNG, DOCX or CSV would widen this
  to every kind of tool, and each one is a small function in `src/watch.mjs`.

## Sponsoring

This is free, stays free, and has no paid edition. The Sponsor button exists for one reason: every site this
drives needs its own small recipe, and every redesign breaks one.

| Tier | What it pays for |
|---|---|
| **$3 a month** | Keeping one recipe working. Fixing a broken one means reading somebody else's new markup, and this covers about one a month. |
| **$25 a month** | The same thing, at the rate that makes sense if you use this in paid work. |
| **$5 once** | For people who would rather give once than subscribe. Both are genuinely useful. |

**No tier buys anything.** No extra features, no support promise, no say in what gets built or which tools are
covered. If a tier ever started buying something, that would be the moment this stopped being worth trusting,
because the entire value of the tool is that its answer does not depend on who is paying.

The tool is maintained alongside [Dialegein](https://dialegein.com), an independent index of PDF tools that
records where each one processes your files.

## Licence

MIT. Take it, change it, ship it.
