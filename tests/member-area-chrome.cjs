// The signed-in member area keeps its own navigation: no shared landing header/footer.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const pages = ['members', 'dashboard', 'analytics', 'analytics-view', 'asset-analysis', 'stock-analysis', 'billing', 'settings']
  .filter(n => fs.existsSync(path.join(root, n + '.html')));
(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html');
    res.end(fs.readFileSync(file));
  }).listen(0, '127.0.0.1');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:') ? r.continue() : r.abort());
    const base = `http://127.0.0.1:${server.address().port}`;
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const n of pages) {
        const html = fs.readFileSync(path.join(root, n + '.html'), 'utf8');
        assert(!html.includes('belfed-site-header.js') && !html.includes('belfed-site-footer.js'), `${n}: no shared scripts`);
        await page.goto(`${base}/${n}.html`);
        await page.waitForTimeout(300);
        assert.equal(await page.locator('#bf-site-header, #bf-site-footer').count(), 0, `${n}: no shared header/footer`);
        assert.equal(await page.locator('[data-bf-legacy-nav]').count(), 0, `${n}: own nav not hidden`);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${n}: no overflow at ${width}`);
        if (process.env.QA_SHOTS && n === 'members') await page.screenshot({ path: `${process.env.QA_SHOTS}-${width}.png` });
      }
    }
    console.log(`PASS ${pages.length} member-area pages x 2 widths: own navigation, no shared header/footer`);
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
