// Browser QA: editor counters follow the automatic Telegram format (caption / text / article).
const { chromium } = require('playwright');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const root = process.argv[2] || process.cwd();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=', 'base64');
const chart = [{ url: 'https://qa.test/a.png', caption_ru: '', caption_en: '' }];

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      const report = { id: 'qa-report', slug: 'qa', status: 'draft', report_date: '2026-10-29', report_type: 'daily', title_ru: 'Тест', title_en: 'Test' };
      const mk = (position, body, charts) => ({ position, section_label_ru: '0' + position, section_label_en: '0' + position, headline_ru: 'Секция ' + position, headline_en: 'Section ' + position, body_ru: body, body_en: body, is_public: true, chart_images: charts });
      const sections = [mk(0, 'Коротко.', chart), mk(1, 'б'.repeat(1500), []), mk(2, 'в'.repeat(5000), []), mk(3, 'г'.repeat(1500), chart)];
      await page.route('**/*', async route => {
        const req = route.request(), url = req.url();
        if (url.includes('supabase-js')) return route.fulfill({ contentType: 'text/javascript', body: `window.supabase={createClient:()=>({
            auth:{getSession:async()=>({data:{session:{access_token:'test',expires_at:9999999999,user:{id:'test'}}}})},
            from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{subscription_status:'admin'}})})})})
          })};` });
        if (url.includes('/functions/v1/analytics-admin-action')) {
          const b = req.postDataJSON();
          let data = {};
          if (b.action === 'get') data = { report, sections };
          return route.fulfill({ json: data });
        }
        if (url.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: png });
        if (url.startsWith('https://qa.test/admin-analytics.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(`${root}/admin-analytics.html`, 'utf8') });
        return route.fulfill({ body: '' });
      });
      await page.goto('https://qa.test/admin-analytics.html?id=qa-report');
      await page.waitForFunction(() => document.body.classList.contains('ready') && document.querySelectorAll('.section-block [data-counter="body_ru"]').length >= 4);
      const sec = i => page.locator('.section-block').filter({ has: page.locator('[data-counter="body_ru"]') }).nth(i);
      const cnt = async (i, lang = 'ru') => (await sec(i).locator(`[data-counter="body_${lang}"]`).textContent()).trim();
      const cls = async (i, lang = 'ru') => await sec(i).locator(`[data-counter="body_${lang}"]`).getAttribute('class');

      assert.match(await cnt(0), /\/ 1024 · подпись под графиком/);
      assert.match(await cnt(1), /\/ 4096 · обычное сообщение/);
      assert.match(await cnt(2), /\/ 32768 · СТАТЬЯ/);
      assert.match(await cnt(3), /\/ 32768 · СТАТЬЯ/);
      assert.doesNotMatch(await cls(0), /over|warn/);
      assert.match(await cls(2), /info/);

      // Typing a long text into the chart section switches it to an article live.
      await sec(0).locator('textarea[data-bind="body_ru"]').evaluate(el => { el.scrollIntoView(); });
      await sec(0).locator('textarea[data-bind="body_ru"]').fill('д'.repeat(1200));
      assert.match(await cnt(0), /СТАТЬЯ/);
      await sec(0).locator('textarea[data-bind="body_ru"]').fill('д'.repeat(100));
      assert.match(await cnt(0), /подпись под графиком/);
      // No-chart section: 4096 boundary.
      await sec(1).locator('textarea[data-bind="body_ru"]').fill('е'.repeat(3000));
      assert.match(await cnt(1), /обычное сообщение/);
      await sec(1).locator('textarea[data-bind="body_ru"]').fill('е'.repeat(4200));
      assert.match(await cnt(1), /СТАТЬЯ/);
      // EN pane counter exists and is independent.
      assert.match(await cnt(0, 'en'), /подпись под графиком|caption|\/ 1024/);

      // Conclusion counters.
      await page.locator('#cb-conclusion').check({ force: true }).catch(() => {});
      await page.evaluate(() => { document.getElementById('cb-conclusion').checked = true; document.getElementById('cb-conclusion').dispatchEvent(new Event('change', { bubbles: true })); });
      await page.locator('#conc-body-ru').fill('ж'.repeat(300));
      const conc = async lang => (await page.locator(`[data-conc-counter="${lang}"]`).textContent()).trim();
      assert.match(await conc('ru'), /\/ 4096 · обычное сообщение/);
      await page.locator('#conc-body-ru').fill('ж'.repeat(5000));
      assert.match(await conc('ru'), /СТАТЬЯ/);

      // Publish is not blocked at 900 and the confirm text lists article sections.
      let dialogText = '';
      page.once('dialog', d => { dialogText = d.message(); d.dismiss(); });
      await page.evaluate(() => { const s = document.getElementById('cb-skip-tg'); if (s) s.checked = false; });
      await page.evaluate(() => onPublish());
      assert.match(dialogText, /Опубликовать отчёт/, 'confirm shown, publish not blocked by 900 limit: ' + dialogText);
      assert.match(dialogText, /Статьёй уйдут секции/);

      // Beyond the article limit publish is blocked with an alert.
      await sec(2).locator('textarea[data-bind="body_ru"]').fill('з'.repeat(33000));
      assert.match(await cls(2), /over/);
      let alertText = '';
      page.once('dialog', d => { alertText = d.message(); d.dismiss(); });
      await page.evaluate(() => onPublish());
      assert.match(alertText, /не помещается даже в статью/);

      await sec(2).locator('textarea[data-bind="body_ru"]').fill('з'.repeat(300));
      await sec(0).scrollIntoViewIfNeeded();
      await sec(0).screenshot({ path: `/home/user/workspace/report-section-format-${width}.png` });
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(e => ({ tag: e.tagName, cls: e.className })));
      assert.deepEqual(overflow, [], 'layout overflow');
      assert.deepEqual(errors, []);
      console.log(`${root}: ${width}px counters, live switching, conclusion, confirm text, article limit block: PASS`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
