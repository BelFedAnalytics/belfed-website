const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = process.cwd();
  const server = http.createServer((req, res) => {
    let file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file += '/index.html';
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html');
    res.end(fs.readFileSync(file));
  }).listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    // No authenticated API calls, analytics, or third-party network side effects.
    await page.route('**/*', route => route.request().url().startsWith('http://127.0.0.1:') ? route.continue() : route.abort());
    const base = `http://127.0.0.1:${server.address().port}`;
    const pages = ['/', '/members.html', '/dashboard.html', '/analytics.html',
      '/asset-analysis.html', '/settings.html', '/about.html', '/research/',
      ...fs.readdirSync('research', { withFileTypes: true }).filter(x => x.isDirectory()).slice(0, 2).map(x => `/research/${x.name}/`)];
    if (fs.existsSync('ru/trades.html')) pages.push('/ru/trades.html', '/learn/');
    else pages.push('/trades.html', '/equities-trades.html');
    let expected;
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const url of pages) {
        await page.goto(base + url);
        await page.waitForSelector('#bf-site-header', { timeout: 4000 });
        const header = page.locator('#bf-site-header');
        const links = await header.locator('[data-bf-primary] a').evaluateAll(items => items.map(x => [x.textContent, x.getAttribute('href')]));
        expected ||= links;
        assert.deepEqual(links, expected, `same menu at ${url}`);
        assert(await header.isVisible());
        assert(await header.evaluate(el => el.getBoundingClientRect().right <= innerWidth), `header fits ${width} ${url}`);
        const languageUrl = await header.locator('.bf-lang').getAttribute('href');
        assert(languageUrl.startsWith(fs.readFileSync('CNAME', 'utf8').trim() === 'belfed.ru' ? 'https://belfed.com/' : 'https://belfed.ru/'));
        assert(await header.locator('.bf-actions').evaluate(el => el.getBoundingClientRect().right <= innerWidth), `actions fit ${width} ${url}`);
        assert.equal(await page.locator('[data-bf-legacy-nav]:visible').count(), 0);
        if (process.env.QA_SHOTS && url === '/' && [1440, 390].includes(width)) {
          if (width === 390) await header.locator('[data-bf-toggle]').click();
          await page.screenshot({ path: `${process.env.QA_SHOTS}-${width}.png` });
          if (width === 390) await page.keyboard.press('Escape');
        }
        const toggle = header.locator('[data-bf-toggle]');
        if (await toggle.isVisible()) {
          await toggle.click();
          assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
          assert(await header.locator('[data-bf-primary]').isVisible());
          await page.keyboard.press('Escape');
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
          assert(await toggle.evaluate(el => el === document.activeElement));
          await toggle.click();
          await page.mouse.click(5, 800);
          assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        }
      }
    }
    console.log(`PASS ${pages.length} pages x 4 viewport widths; parity, fit, mobile, Escape and outside click`);
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
