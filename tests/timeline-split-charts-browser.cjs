// Browser QA: Timeline editor "different charts for RU and EN" (analysis_posts.image_paths_en).
//   node tests/timeline-split-charts-browser.cjs [repo root]   (needs playwright)
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = process.argv[2] || process.cwd();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      const saved = { uploads: [], inserts: [] };
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const url = route.request().url();
        if (url.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: `
          window.__uploads = []; window.__inserts = [];
          window.supabase={createClient:()=>({
            auth:{getSession:async()=>({data:{session:{access_token:'test',expires_at:9999999999,user:{id:'test'}}}})},
            storage:{from:()=>({upload:async(p)=>{window.__uploads.push(p);return {error:null}},getPublicUrl:p=>({data:{publicUrl:'https://qa.test/'+p}})})},
            from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{subscription_status:'admin'}})})}),
              insert:(row)=>{window.__inserts.push(row);return {select:()=>({maybeSingle:async()=>({data:{id:'x1',slug:'s'}})})}},
              update:(row)=>{window.__inserts.push(row);return {eq:async()=>({error:null})}}})
          })};` });
        if (url.includes('/functions/v1/')) return route.fulfill({ json: {} });
        if (url.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: png });
        if (url.startsWith('blob:')) return route.continue();
        if (url.startsWith('https://qa.test/admin-analytics.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(`${root}/admin-analytics.html`, 'utf8') });
        return route.fulfill({ body: '' });
      });
      page.on('dialog', d => d.accept());
      await page.goto('https://qa.test/admin-analytics.html');
      await page.waitForFunction(() => document.body.classList.contains('ready') && document.getElementById('tl-files'));

      await page.locator('#tl-files').setInputFiles([
        { name: 'a.png', mimeType: 'image/png', buffer: png },
        { name: 'b.png', mimeType: 'image/png', buffer: png },
      ]);
      await page.waitForSelector('#tl-thumbs .thumb');
      assert.equal(await page.locator('#tl-thumbs .thumb').count(), 2);
      assert.equal(await page.locator('.tl-pair').count(), 0, 'plain mode has no pairs');

      // Toggle split on: two pairs, EN slots empty.
      await page.locator('#tl-charts-split').check();
      assert.equal(await page.locator('.tl-pair').count(), 2);
      assert.equal(await page.locator('.tl-en-drop').count(), 2);
      assert.equal(await page.locator('#tl-charts-split-hint').isVisible(), true);

      // Upload an EN chart for the first image only.
      const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.locator('.tl-en-drop').first().click(),
      ]);
      await chooser.setFiles({ name: 'a_en.png', mimeType: 'image/png', buffer: png });
      await page.waitForSelector('.tl-pair [data-act="en-del"]');
      assert.equal(await page.locator('.tl-en-drop').count(), 1);
      assert.equal(await page.locator('.tl-pair .thumb').count(), 3);

      if (process.env.SHOT) await page.locator('#timeline-fields').screenshot({ path: `/tmp/split-${width}.png` });
      // No horizontal overflow of the pair grid.
      const over = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
      assert.equal(over, false, 'no horizontal overflow at ' + width);

      // Save: image_paths has 2 entries, image_paths_en aligned [path, null].
      await page.locator('#tl-headline-ru').fill('Заголовок');
      await page.locator('#tl-headline-en').fill('Headline');
      await page.locator('#tl-cat-chips button').first().click();
      await page.evaluate(() => onSaveDraft());
      await page.waitForFunction(() => window.__inserts.length > 0);
      const row = await page.evaluate(() => window.__inserts[0]);
      assert.equal(row.image_paths.length, 2);
      assert.equal(row.image_paths_en.length, 2);
      assert.match(row.image_paths_en[0], /_0_en\.png$/);
      assert.equal(row.image_paths_en[1], null);
      assert.equal(await page.evaluate(() => window.__uploads.length), 3);

      // Toggle off (confirm accepted): EN charts dropped, image_paths_en empty on next save.
      await page.locator('#tl-charts-split').uncheck();
      assert.equal(await page.locator('.tl-pair').count(), 0);
      await page.evaluate(() => onSaveDraft());
      await page.waitForFunction(() => window.__inserts.length > 1);
      const row2 = await page.evaluate(() => window.__inserts[1]);
      assert.deepEqual(row2.image_paths_en, []);
      assert.deepEqual(errors, [], 'no page errors');
      await page.close();
    }
    console.log('timeline-split-charts-browser: all checks passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
