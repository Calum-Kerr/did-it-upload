/**
 * An example recipe.
 *
 * A recipe is the only part of this that cannot be shared between tools, because every site lays its
 * upload box out differently. It is usually ten lines: find the file input, set the file, click the
 * thing that starts the job. That cost per tool is exactly why nobody has done this at scale.
 *
 * Copy this file, change the selectors, run it:
 *
 *   node src/check.mjs https://example.com/some-pdf-tool --recipe ./recipes/example.mjs
 *
 * TWO THINGS TO GET RIGHT
 *
 * 1. WAIT FOR THE TOOL TO FINISH. If the action returns before the work starts, the upload has not
 *    happened yet and the result is a clean reading for the wrong reason. Wait for whatever the site
 *    shows when it is done: a download button, a "finished" label, a preview.
 *
 * 2. CONFIRM SOMETHING HAPPENED. A download is checked for you automatically, and that is the best
 *    signal available. If the tool finishes without offering a download, use `confirm` to say what you
 *    saw, so a run where the recipe did nothing cannot be mistaken for a tool that kept the file.
 */
export default {
  async act(page, file) {
    /* The file input. Many sites hide it behind a button; setInputFiles works on the input itself. */
    await page.locator('input[type=file]').first().setInputFiles(file);

    /* Start the job. Prefer a role and a name over a CSS class, because names survive redesigns. */
    const run = page.getByRole('button', { name: /merge|convert|compress|process|start|upload/i }).first();
    if (await run.count()) {
      await run.click({ timeout: 15_000 }).catch(() => {});
    }

    /* Let it work. WebAssembly jobs on a large file can take a while; this is a small one. */
    await page.waitForTimeout(10_000);
  },

  /**
   * Optional. Say what you saw, in a sentence, or return ok: false to force an INCONCLUSIVE verdict.
   * A false here is not a failure: it is the honest answer when the tool gave no sign of running.
   */
  async confirm(page) {
    const text = await page.locator('body').innerText().catch(() => '');
    const finished = /complete|finished|done|ready|success/i.test(text);
    return finished
      ? { ok: true, evidence: 'The page reported the job as finished.' }
      : { ok: false, evidence: 'The page never reported finishing, so the tool may not have run.' };
  },
};
