// Browser QA: per-section toggle for separate RU/EN chart versions.
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
      let report = { id: 'qa-report', slug: 'qa', status: 'draft', report_date: '2026-10-29', report_type: 'daily', title_ru: 'Тест', title_en: 'Test' };
      let sections = [
        { position: 0, section_label_ru: '01', section_label_en: '01', headline_ru: 'Секция A', headline_en: 'Section A', body_ru: '', body_en: '', is_public: true,
          chart_images: [{ url: 'https://qa.test/old.png', caption_ru: 'подпись', caption_en: 'caption' }] },
        { position: 1, section_label_ru: '02', section_label_en: '02', headline_ru: 'Секция B', headline_en: 'Section B', body_ru: '', body_en: '', is_public: true,
          chart_images: [{ url: 'https://qa.test/b.png', caption_ru: '', caption_en: '' }] },
      ];
      let saved, uploads = 0;
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
          if (b.action === 'save') { saved = b; sections = b.sections; data = { ok: true, report_id: report.id }; }
          if (b.action === 'upload') { uploads++; data = { signed_url: `https://qa.test/upload/${uploads}`, public_url: `https://qa.test/chart-${uploads}.png` }; }
          return route.fulfill({ json: data });
        }
        if (url.includes('/upload/')) return route.fulfill({ status: 200, body: '' });
        if (url.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: png });
        if (url.startsWith('https://qa.test/admin-analytics.html')) return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(`${root}/admin-analytics.html`, 'utf8') });
        return route.fulfill({ body: '' });
      });
      const open = async () => {
        await page.goto('https://qa.test/admin-analytics.html?id=qa-report');
        await page.waitForFunction(() => document.body.classList.contains('ready') && document.querySelectorAll('.section-block [data-charts-split]').length >= 2);
      };
      const secA = () => page.locator('.section-block').filter({ has: page.locator('[data-charts-split]') }).nth(0);
      const secB = () => page.locator('.section-block').filter({ has: page.locator('[data-charts-split]') }).nth(1);
      const save = async () => {
        saved = null;
        await page.locator('#btn-save').click();
        await page.waitForFunction(() => document.querySelector('#top-msg').textContent.includes('Сохранено'));
        assert.ok(saved);
      };
      await open();
      // Default: one chart, toggle off, no EN slot.
      assert.equal(await secA().locator('[data-charts-split]').isChecked(), false);
      assert.equal(await secA().locator('[data-chart-dz-en]').count(), 0);
      assert.equal(await secA().locator('[data-charts-split-hint]').isHidden(), true);
      // Enable in section A only.
      await secA().locator('[data-charts-split]').check();
      assert.equal(await secA().locator('[data-chart-dz-en]').count(), 1);
      assert.equal(await secA().locator('[data-charts-split-hint]').isVisible(), true);
      assert.equal(await secB().locator('[data-chart-dz-en]').count(), 0, 'other sections stay single');
      // Upload EN (keyboard on desktop, click on mobile).
      const chooser = page.waitForEvent('filechooser');
      if (width === 1280) { await secA().locator('[data-chart-dz-en]').focus(); await secA().locator('[data-chart-dz-en]').press('Enter'); }
      else await secA().locator('[data-chart-dz-en]').click();
      await (await chooser).setFiles({ name: 'en.png', mimeType: 'image/png', buffer: png });
      await secA().locator('[data-chart-dz-en] img[src$="chart-1.png"]').waitFor();
      // Replace RU independently.
      const chooser2 = page.waitForEvent('filechooser');
      await secA().locator('[data-chart-dz]').click();
      await (await chooser2).setFiles({ name: 'ru.png', mimeType: 'image/png', buffer: png });
      await secA().locator('[data-chart-dz] img[src$="chart-2.png"]').waitFor();
      assert.equal(await secA().locator('[data-chart-dz-en] img').getAttribute('src'), 'https://qa.test/chart-1.png');
      await save();
      assert.deepEqual(saved.sections[0].chart_images, [{ url: 'https://qa.test/chart-2.png', url_en: 'https://qa.test/chart-1.png', caption_ru: 'подпись', caption_en: 'caption' }]);
      assert.equal(saved.sections[0].chart_image_url, 'https://qa.test/chart-2.png', 'legacy mirror stays RU');
      assert.equal('url_en' in saved.sections[1].chart_images[0], false);
      // Reload: toggle restored from data.
      await open();
      assert.equal(await secA().locator('[data-charts-split]').isChecked(), true);
      assert.equal(await secB().locator('[data-charts-split]').isChecked(), false);
      await secA().locator('[data-chart-dz-en] img[src$="chart-1.png"]').waitFor();
      if (width === 1280) {
        await page.screenshot({ path: `/home/user/workspace/report-section-charts-${width}.png`, fullPage: false, clip: await secA().boundingBox() });
      }
      // Remove EN only: RU stays, EN slot becomes empty.
      await secA().locator('[data-act="chart-en-del"]').click();
      assert.equal(await secA().locator('[data-chart-dz-en] img').count(), 0);
      assert.equal(await secA().locator('[data-chart-dz] img').getAttribute('src'), 'https://qa.test/chart-2.png');
      await save();
      assert.equal('url_en' in saved.sections[0].chart_images[0], false);
      // Toggle off with an EN chart asks for confirmation; cancel keeps it.
      await open();
      await secA().locator('[data-charts-split]').check();
      const chooser3 = page.waitForEvent('filechooser');
      await secA().locator('[data-chart-dz-en]').click();
      await (await chooser3).setFiles({ name: 'en2.png', mimeType: 'image/png', buffer: png });
      await secA().locator('[data-chart-dz-en] img').waitFor();
      page.once('dialog', d => d.dismiss());
      await secA().locator('[data-charts-split]').uncheck({ force: true }).catch(() => {});
      assert.equal(await secA().locator('[data-charts-split]').isChecked(), true);
      assert.equal(await secA().locator('[data-chart-dz-en] img').count(), 1);
      page.once('dialog', d => d.accept());
      await secA().locator('[data-charts-split]').click();
      assert.equal(await secA().locator('[data-charts-split]').isChecked(), false);
      assert.equal(await secA().locator('[data-chart-dz-en]').count(), 0);
      await save();
      assert.equal('url_en' in saved.sections[0].chart_images[0], false);
      // Mobile/desktop: split pair must not overflow.
      await secA().locator('[data-charts-split]').check();
      await page.screenshot({ path: `/home/user/workspace/report-section-charts-full-${width}.png`, fullPage: true });
      const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].filter(e => e.getBoundingClientRect().right > innerWidth + 1).slice(0, 12).map(e => ({ tag: e.tagName, cls: e.className })));
      assert.deepEqual(overflow, [], 'layout overflow');
      assert.deepEqual(errors, []);
      console.log(`${root}: ${width}px default single chart, per-section toggle, EN upload (keyboard), RU replace, save/reload, EN remove, confirm on disable, no overflow: PASS`);
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
