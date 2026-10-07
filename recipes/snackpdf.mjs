/**
 * A real recipe, for SnackPDF's compress tool.
 *
 * WHY THIS ONE IS SHIPPED. It is the author's own product, so it can be driven as often as needed without
 * asking anybody, and it is a genuinely useful worked example: a file input, a start button, and a
 * download that confirms the job finished. The generic template is `recipes/example.mjs`.
 *
 *   node src/check.mjs https://www.snackpdf.com/compress-pdf --recipe ./recipes/snackpdf.mjs
 */
export default {
  async act(page, file) {
    const input = page.locator('input[type="file"]').first();
    await input.waitFor({ state: 'attached', timeout: 20_000 });
    await input.setInputFiles(file);

    await page.waitForTimeout(1_500);

    const start = page
      .getByRole('button', { name: /compress|start|continue|download|save/i })
      .first();
    if (await start.count().catch(() => 0)) {
      await start.click({ timeout: 5_000 }).catch(() => {});
    }
  },

  /**
   * Proof the tool processed the file.
   *
   * Without this, a page that silently failed to load produces exactly the same observation as a tool
   * that genuinely kept the file on the device: zero uploads. Only one of those is a finding, and the
   * difference is whether anything confirms the job ran.
   */
  async confirm(page) {
    const download = page
      .getByRole('link', { name: /download/i })
      .or(page.getByRole('button', { name: /download|save/i }));

    const appeared = await download
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .then(() => true)
      .catch(() => false);

    return {
      ok: appeared,
      evidence: appeared
        ? 'A download control appeared after processing, so the tool did run.'
        : 'No download control appeared within 20 seconds, so we cannot confirm the tool processed the file.',
    };
  },
};
