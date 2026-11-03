// Asset Analysis must load EVERY published post (not just the newest 200),
// so older tickers (e.g. NOW, Jul 2) are searchable and permalinks resolve.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('playwright-core')); }
const root = path.resolve(__dirname, '..');
const TOTAL = 1200;

function makePosts() {
  const posts = [];
  const base = Date.parse('2026-11-03T12:00:00Z');
  for (let i = 0; i < TOTAL; i++) {
    const t = new Date(base - i * 3600e3 * 4).toISOString();
    posts.push({ id: 'id-' + i, ticker: 'T' + (i % 97), company_name: 'Co ' + i, asset_class: i % 5 ? 'stocks' : 'crypto',
      post_type: 'update', body_ru: 'ru ' + i, body_en: 'en ' + i, published_at: t, created_at: t, slug: 't' + (i % 97) + '-' + i,
      parent_post_id: null, image_paths: [], hashtags: '#t' });
  }
  // NOW sits far beyond the old 200-post window
  posts[1000] = Object.assign({}, posts[1000], { ticker: 'NOW', company_name: 'ServiceNow', slug: 'now-2026-07-02' });
  return posts;
}

// Minimal PostgREST-like fake: count, range, and a server-side max-rows cap.
function fakeClient(posts, opts) {
  let calls = 0;
  return {
    calls: () => calls,
    from() {
      const q = { from: 0, to: null, count: false };
      const b = {
        select(_c, o) { q.count = !!(o && o.count); return b; },
        eq() { return b; }, order() { return b; },
        limit(n) { q.to = n - 1; return b; },
        range(a, z) { q.from = a; q.to = z; return b; },
        then(res, rej) {
          calls++;
          if (opts.failOnCall && calls === opts.failOnCall) return Promise.resolve({ data: null, error: { message: 'boom' } }).then(res, rej);
          let to = q.to == null ? posts.length - 1 : q.to;
          to = Math.min(to, q.from + opts.maxRows - 1);
          return Promise.resolve({ data: posts.slice(q.from, to + 1), count: q.count ? posts.length : null, error: null }).then(res, rej);
        }
      };
      return b;
    }
  };
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(req.url.split('?')[0]));
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end(); }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  }).listen(0, '127.0.0.1');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('**/*', r => r.request().url().startsWith('http://127.0.0.1:') ? r.continue() : r.abort());
    const base = `http://127.0.0.1:${server.address().port}`;
    const posts = makePosts();
    async function run(label, opts, hash) {
      await page.goto(`${base}/asset-analysis.html${hash || ''}`);
      await page.waitForTimeout(200);
      await page.evaluate(({ posts, opts, fakeSrc }) => {
        window.__mk = new Function('return ' + fakeSrc)();
        window.supaClient = window.__mk(posts, opts);
        document.body.style.visibility = 'visible';
      }, { posts, opts, fakeSrc: fakeClient.toString() });
      await page.evaluate(() => loadPosts());
      return page.evaluate(() => ({
        loaded: state.posts.length,
        unique: new Set(state.posts.map(p => p.id)).size,
        cards: document.querySelectorAll('#feed .card').length,
        count: document.getElementById('feedCount').textContent,
        err: document.getElementById('errorBox').style.display,
        errText: document.getElementById('errorBox').textContent,
        hasNow: !!document.querySelector('.card[data-slug="now-2026-07-02"]'),
        calls: window.supaClient.calls()
      }));
    }
    // 1. API cap 1000 rows: used to show 200, now all 1200
    let r = await run('cap1000', { maxRows: 1000 });
    assert.equal(r.loaded, TOTAL, 'loads all posts: ' + JSON.stringify(r));
    assert.equal(r.unique, TOTAL);
    assert.equal(r.err, 'none');
    assert(r.calls >= 3 && r.calls <= 4, 'paged requests: ' + r.calls);
    assert(r.count.includes(String(TOTAL)), 'count shows total: ' + r.count);
    assert(r.cards > 200, 'renders more than the old 200: ' + r.cards);
    // 2. Server cap smaller than page size must still page to the end
    r = await run('cap100', { maxRows: 100 });
    assert.equal(r.loaded, TOTAL, 'small server cap: ' + JSON.stringify(r));
    // 3. Old ticker is searchable
    await page.evaluate(() => { state.ticker = 'NOW'; applyFilters(); });
    assert.equal(await page.locator('.card[data-slug="now-2026-07-02"]').count(), 1, 'NOW (Jul 2) found by ticker search');
    // 4. Permalink to an old post resolves
    r = await run('permalink', { maxRows: 1000 }, '#now-2026-07-02');
    assert.equal(r.hasNow, true, 'permalink resolves: ' + JSON.stringify(r));
    // 5. Failure on a later page keeps loaded posts and shows a notice
    r = await run('partial', { maxRows: 1000, failOnCall: 2 });
    assert.equal(r.loaded, 500);
    assert.equal(r.err, 'block');
    assert(r.cards > 0);
    // 6. Failure on the first page still shows the error state
    r = await run('fail', { maxRows: 1000, failOnCall: 1 });
    assert.equal(r.loaded === 0 || r.cards === 0, true);
    assert.equal(r.err, 'block');
    console.log('PASS asset-analysis loads all posts (paging, small cap, ticker search, permalink, partial failure)');
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
