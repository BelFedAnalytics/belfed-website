// Browser QA: Timeline editor counters follow the automatic Telegram format (post / text / article).
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
      page.on('pageerror', e => errors.push(e.message));
      await page.route('**/*', async route => {
        const req = route.request(), url = req.url();
        if (url.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: `window.supabase={createClient:()=>({
            auth:{getSession:async()=>({data:{session:{access_token:'test',expires_at:9999999999,user:{id:'test'}}}})},
            from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{subscription_status:'admin'}})})})})
          })};` });
        if (url.includes('/functions/v1/')) return route.fulfill({ json: {} });
        if (url.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: png });
        if (url.startsWith('https://qa.test/admin-analytics.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(`${root}/admin-analytics.html`, 'utf8') });
        return route.fulfill({ body: '' });
      });
      await page.goto('https://qa.test/admin-analytics.html');
      await page.waitForFunction(() => document.body.classList.contains('ready') && document.getElementById('tl-cap-ru'));
      const cap = async lang => (await page.locator(`#tl-cap-${lang}`).textContent()).trim();
      const cls = async lang => await page.locator(`#tl-cap-${lang}`).getAttribute('class');
      const fill = async (id, v) => { await page.locator(id).fill(v); };

      await fill('#tl-headline-ru', 'Заголовок');
      await fill('#tl-headline-en', 'Headline');
      // No chart: regular message up to 4096.
      await fill('#tl-body-ru', 'б'.repeat(1500));
      assert.match(await cap('ru'), /^RU · \d+ \/ 4096 · обычное сообщение/);
      await fill('#tl-body-ru', 'б'.repeat(4200));
      assert.match(await cap('ru'), /\/ 32768 · СТАТЬЯ: длинный текст одним постом/);
      assert.match(await cls('ru'), /info/);
      await fill('#tl-body-ru', 'б'.repeat(300));
      await fill('#tl-body-en', 'b'.repeat(300));

      // With a chart the limit is 1024 and longer text becomes an article.
      await page.locator('#tl-files').setInputFiles({ name: 'c.png', mimeType: 'image/png', buffer: png });
      await page.waitForSelector('#tl-thumbs .thumb');
      assert.match(await cap('ru'), /^RU · \d+ \/ 1024 · подпись под графиком/);
      assert.match(await cap('en'), /^EN · \d+ \/ 1024 · подпись под графиком/);
      await fill('#tl-body-ru', 'б'.repeat(1100));
      assert.match(await cap('ru'), /\/ 32768 · СТАТЬЯ: текст и графики одним постом/);
      assert.match(await cap('en'), /1024 · подпись под графиком/, 'EN is counted on its own');

      // Confirmation names the format (one format per post, the longer language decides).
      await page.locator('#tl-cat-chips button').first().click();
      let dialog = '';
      page.once('dialog', d => { dialog = d.message(); d.dismiss(); });
      await page.evaluate(() => onPublish());
      assert.match(dialog, /Опубликовать пост в ленту/);
      assert.match(dialog, /СТАТЬЯ \(\d+ зн\.\)/, dialog);

      // Removing the chart switches the same text back to a regular message.
      await page.locator('#tl-thumbs .x').first().click();
      assert.match(await cap('ru'), /\/ 4096 · обычное сообщение/);
      await fill('#tl-body-ru', 'б'.repeat(300));
      page.once('dialog', d => { dialog = d.message(); d.dismiss(); });
      await page.evaluate(() => onPublish());
      assert.match(dialog, /обычное сообщение/);
      assert.doesNotMatch(dialog, /СТАТЬЯ/);

      // Publishing is blocked only above the article limit.
      await fill('#tl-body-ru', 'б'.repeat(33000));
      assert.match(await cls('ru'), /over/);
      dialog = '';
      page.once('dialog', d => { dialog = d.message(); d.dismiss(); });
      await page.evaluate(() => onPublish());
      assert.equal(dialog, '', 'no confirm when over the article limit');
      assert.match(await page.locator('#top-msg').textContent(), /не помещается даже в статью/);
      await fill('#tl-body-ru', 'б'.repeat(300));

      await page.locator('#tl-cap-ru').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `/home/user/workspace/timeline-auto-format-${width}.png` });
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(e => ({ tag: e.tagName, id: e.id, cls: String(e.className) })));
      assert.deepEqual(overflow, [], 'layout overflow');
      assert.deepEqual(errors, []);
      console.log(`${root}: ${width}px timeline counters, chart toggle, confirm text, article limit block: PASS`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
