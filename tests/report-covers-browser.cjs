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
      let report = {
        id: 'qa-report', slug: 'qa', status: 'draft', report_date: '2026-10-27',
        report_type: 'daily', title_ru: 'Тест', title_en: 'Test',
        cover_image_url: 'https://qa.test/legacy.png',
      };
      let saved;
      let uploads = 0;
      await page.route('**/*', async route => {
        const req = route.request(), url = req.url();
        if (url.includes('supabase-js')) return route.fulfill({
          contentType: 'text/javascript',
          body: `window.supabase={createClient:()=>({
            auth:{getSession:async()=>({data:{session:{access_token:'test',expires_at:9999999999,user:{id:'test'}}}})},
            from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:{subscription_status:'admin'}})})})})
          })};`,
        });
        if (url.includes('/functions/v1/analytics-admin-action')) {
          const b = req.postDataJSON();
          let data = {};
          if (b.action === 'get') data = { report, sections: [] };
          if (b.action === 'save') {
            saved = b; report = { ...report, ...b, id: 'qa-report' };
            data = { ok: true, report_id: report.id };
          }
          if (b.action === 'upload') {
            uploads++;
            data = { signed_url: `https://qa.test/upload/${uploads}`, public_url: `https://qa.test/cover-${uploads}.png` };
          }
          return route.fulfill({ json: data });
        }
        if (url.includes('/upload/')) return route.fulfill({ status: 200, body: '' });
        if (url.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: png });
        if (url.startsWith('https://qa.test/admin-analytics.html')) {
          return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(`${root}/admin-analytics.html`, 'utf8') });
        }
        return route.fulfill({ body: '' });
      });
      await page.goto('https://qa.test/admin-analytics.html?id=qa-report');
      await page.waitForFunction(() => state.destination === 'report' && document.body.classList.contains('ready'));
      await page.locator('#dz-cover-ru img').waitFor();
      await page.locator('#dz-cover-en img').waitFor();
      assert.equal(await page.locator('#dz-cover-ru img').getAttribute('src'), report.cover_image_url);
      async function upload(lang, name) {
        const expected = uploads + 1;
        const chooser = page.waitForEvent('filechooser');
        await page.locator(`#dz-cover-${lang}`).click();
        await (await chooser).setFiles({ name, mimeType: 'image/png', buffer: png });
        await page.waitForFunction(({ lang, n }) => document.querySelector(`#dz-cover-${lang} img`)?.src.endsWith(`cover-${n}.png`), { lang, n: expected });
      }
      // Keyboard opens a picker too.
      if (width === 1280) {
      await page.locator('#dz-cover-ru').scrollIntoViewIfNeeded();
      await page.locator('#dz-cover-ru').focus();
      const chooser = page.waitForEvent('filechooser');
      await page.locator('#dz-cover-ru').press('Enter');
      await (await chooser).setFiles({ name: 'ru.png', mimeType: 'image/png', buffer: png });
      await page.locator('#dz-cover-ru img[src$="cover-1.png"]').waitFor();
      } else {
        await upload('ru', 'ru.png');
      }
      await upload('en', 'en.png');
      await page.locator('#btn-save').click();
      await page.waitForFunction(() => document.querySelector('#top-msg').textContent.includes('Сохранено'));
      assert.equal(saved.cover_image_url, null);
      assert.equal(saved.cover_image_url_ru, 'https://qa.test/cover-1.png');
      assert.equal(saved.cover_image_url_en, 'https://qa.test/cover-2.png');
      await page.reload();
      await page.locator('#dz-cover-en img[src$="cover-2.png"]').waitFor();
      page.once('dialog', d => d.accept());
      await page.locator('#dz-cover-ru .dz-remove').click();
      assert.equal(await page.locator('#dz-cover-ru img').count(), 0);
      assert.equal(await page.locator('#dz-cover-en img').getAttribute('src'), 'https://qa.test/cover-2.png');
      await page.locator('#btn-save').click();
      await page.waitForFunction(() => document.querySelector('#top-msg').textContent.includes('Сохранено'));
      assert.equal(saved.cover_image_url_ru, null);
      await page.reload();
      await page.locator('#dz-cover-en img').waitFor();
      assert.equal(await page.locator('#dz-cover-ru img').count(), 0);
      await page.screenshot({ path: `/home/user/workspace/report-covers-${width}.png`, fullPage: true });
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(e => ({ tag: e.tagName, id: e.id, cls: e.className, width: e.getBoundingClientRect().width })));
      assert.deepEqual(overflow, [], 'mobile layout overflow');
      assert.deepEqual(errors, []);
      console.log(`${root}: ${width}px legacy load, keyboard upload, independent covers, save/reload, remove/reload, no overflow: PASS`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
