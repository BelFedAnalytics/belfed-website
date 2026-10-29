const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = process.cwd();
  const ru = fs.readFileSync('CNAME', 'utf8').trim() === 'belfed.ru';
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
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*', route => route.request().url().startsWith(base) ? route.continue() : route.abort());
    const pages = ['/', '/members.html', '/dashboard.html', '/analytics.html', '/asset-analysis.html',
      '/settings.html', '/about.html', '/research/', '/learn/', ru ? '/ru/trades.html' : '/trades.html',
      ru ? '/ru/privacy.html' : '/privacy.html', ru ? '/ru/oferta.html' : '/terms.html',
      ...fs.readdirSync('research', { withFileTypes: true }).filter(x => x.isDirectory()).slice(0, 2).map(x => `/research/${x.name}/`)];
    let expected;
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      for (const url of pages) {
        await page.goto(base + url);
        const footer = page.locator('#bf-site-footer');
        await footer.waitFor({ state: 'visible', timeout: 4000 });
        assert.equal(await footer.count(), 1);
        const links = await footer.locator('[data-bf-footer-group] a').evaluateAll(items => items.map(x => [x.textContent, x.getAttribute('href')]));
        expected ||= links;
        assert.deepEqual(links, expected, `same links ${url}`);
        for (const [, href] of links) {
          if (href.startsWith('/')) {
            let target = path.join(root, href.split('#')[0]);
            if (href.endsWith('/') || href.split('#')[0] === '/') target += '/index.html';
            assert(fs.existsSync(target), `target exists: ${href}`);
          }
        }
        assert.equal(await page.locator('[data-bf-legacy-footer]:visible').count(), 0);
        assert(await footer.evaluate(el => el.getBoundingClientRect().left >= -1 && el.getBoundingClientRect().right <= innerWidth + 1));
        assert(await footer.locator('a').evaluateAll(els => els.every(el => el.getBoundingClientRect().right <= innerWidth + 1 && el.getBoundingClientRect().left >= -1)), `all links fit ${url} ${width}`);
        assert((await footer.locator('.bf-foot-risk').textContent()).includes(ru ? 'Прошлые результаты' : 'Past performance'));
        assert.equal(await footer.locator('.bf-foot-language').getAttribute('href'), await page.locator('#bf-site-header .bf-lang').getAttribute('href'));
        if (process.env.QA_SHOTS && url === '/' && [1440, 390].includes(width)) {
          await page.locator('#bf-site-header').evaluate(el => el.style.visibility = 'hidden');
          await footer.screenshot({ path: `${process.env.QA_SHOTS}-${width}.png` });
          await page.locator('#bf-site-header').evaluate(el => el.style.visibility = '');
        }
        await page.addScriptTag({ url: base + '/belfed-site-footer.js' });
        assert.equal(await footer.count(), 1, 'idempotent');
        if (url === '/') {
          await footer.locator('a[href="#bf-site-header"]').click();
          await page.waitForFunction(() => window.scrollY < 100, null, { timeout: 2000 });
          assert(await page.locator('#bf-site-header .bf-logo').evaluate(el => el === document.activeElement), 'back-to-top restores keyboard focus');
        }
      }
    }
    console.log(`PASS ${pages.length} pages x 4 widths: footer parity, links, legal warning, language, overflow and idempotence`);
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
