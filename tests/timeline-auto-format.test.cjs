// QA for the automatic Telegram format of Timeline (lenta) posts (analysis-publish v29).
//   node tests/timeline-auto-format.test.cjs      (TYPESCRIPT_PATH may point at a typescript install)
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

function fakeDb(initial) {
  const state = { post: { ...initial }, updates: [] };
  const from = table => {
    const q = { op: 'select', payload: null, like: false };
    const run = () => {
      if (table === 'analysis_posts') {
        if (q.op === 'update') { Object.assign(state.post, q.payload); state.updates.push(q.payload); return Promise.resolve({ error: null }); }
        if (q.like) return Promise.resolve({ data: [], error: null });
        return Promise.resolve({ data: JSON.parse(JSON.stringify(state.post)), error: null });
      }
      if (table === 'telegram_topics') return Promise.resolve({ data: { chat_id: -1001, thread_id: 7 }, error: null });
      if (table === 'profiles') return Promise.resolve({ data: { telegram_id: 777 }, error: null });
      return Promise.resolve({ data: [], error: null });
    };
    const chain = {
      select: () => chain, eq: () => chain, in: () => chain, not: () => chain, limit: () => chain,
      like: () => { q.like = true; return chain; },
      update: p => { q.op = 'update'; q.payload = p; return chain; },
      upsert: () => run(),
      single: run, maybeSingle: run, then: (a, b) => run().then(a, b),
    };
    return chain;
  };
  return { from, state, auth: {} };
}

function load(db, fetchImpl) {
  const source = fs.readFileSync('supabase/functions/analysis-publish/index.ts', 'utf8').replace(/^import .*;\s*$/gm, '');
  const out = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal(out.diagnostics.length, 0, 'TypeScript syntax');
  const calls = [];
  const ctx = vm.createContext({
    Deno: { env: { get: () => 'test' }, serve: () => {} },
    createClient: () => db, Response, Request, URL, URLSearchParams, TextEncoder, console: { ...console, error: () => {} }, FormData, Blob, setTimeout: f => { f(); return 0; },
    fetch: async (url, init) => fetchImpl(url, init, calls),
  });
  vm.runInContext(out.outputText, ctx);
  ctx.calls = calls;
  return ctx;
}

function telegram({ fail = new Set() } = {}) {
  let id = 100;
  return async (url, init, calls) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    if (!m) return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => 'image/png' } };
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body && typeof init.body.get === 'function') body = { caption: init.body.get('caption') };
    calls.push({ method: m[1], body });
    if (fail.has(m[1])) return { status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: test failure' }) };
    return { status: 200, json: async () => ({ ok: true, result: m[1] === 'sendMediaGroup' ? [{ message_id: ++id }] : { message_id: ++id } }) };
  };
}

const img = n => Array.from({ length: n }, (_, i) => `u1/${i}.png`);
const mkPost = (over = {}) => ({
  id: 'p1', ticker: null, company_name: null, post_type: 'update', destination: 'timeline', status: 'draft',
  headline_ru: 'Заголовок', headline_en: 'Headline', greeting_ru: null, greeting_en: null,
  body_ru: 'Текст. ', body_en: 'Text. ', source: 'Reuters', hashtags: '#macro', tradingview_url: null,
  image_paths: [], image_meta: [], related_links: [], publish_to_ru: true, publish_to_en: true,
  message_id_ru: null, message_id_en: null, parent_post_id: null, slug: 'headline-2026-11-04', published_at: null,
  tg_text_only: false, tg_format: 'post', created_at: '2026-11-04T00:00:00Z', ...over,
});
const words = (w, n) => (w.repeat(Math.ceil(n / w.length) + 1)).slice(0, n);

async function scenario(post, fn, opts = {}) {
  const db = fakeDb(post);
  const ctx = load(db, telegram(opts));
  const res = JSON.parse(JSON.stringify(await vm.runInContext(fn, ctx)));
  return { res, calls: ctx.calls.map(c => c.method), raw: ctx.calls, state: db.state, ctx };
}

// Bodies that make the visible message exactly `target` characters in each language.
async function bodyForVisible(base, target) {
  const ctx = load(fakeDb(base), telegram());
  await vm.runInContext('loadFooters()', ctx);
  const zero = lang => { ctx.p = { ...base, body_ru: 'а', body_en: 'a' }; ctx.l = lang; return vm.runInContext('tgVisibleLength(buildText(p, l))', ctx); };
  return { ru: words('а', target - zero('ru') + 1), en: words('a', target - zero('en') + 1) };
}

(async () => {
  // 1. Boundaries with an image: 1024 stays a regular post, 1025 becomes an article.
  for (const [target, expect] of [[1024, 'post'], [1025, 'article']]) {
    const base = mkPost({ image_paths: img(1) });
    const b = await bodyForVisible(base, target);
    const { res, calls, state } = await scenario({ ...base, body_ru: b.ru, body_en: b.en }, 'actionPublish("p1")');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.format, expect, `format at ${target}`);
    if (expect === 'post') {
      assert.deepEqual(calls, ['sendPhoto', 'sendPhoto']);
      assert.equal(state.post.tg_format, 'post');
    } else {
      assert.deepEqual(calls, ['sendRichMessage', 'sendRichMessage']);
      assert.equal(state.post.tg_format, 'article', 'format persisted');
    }
    assert.equal(state.post.status, 'published');
    assert.equal(res.visible_len >= target, true);
  }

  // 2. Without images the limit is 4096.
  for (const [target, expect, method] of [[4096, 'post', 'sendMessage'], [4097, 'article', 'sendRichMessage']]) {
    const base = mkPost();
    const b = await bodyForVisible(base, target);
    const { res, calls } = await scenario({ ...base, body_ru: b.ru, body_en: b.en }, 'actionPublish("p1")');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.format, expect, `no-image format at ${target}`);
    assert.deepEqual(calls, [method, method]);
  }

  // 3. The longer language decides for both languages (consistent format per post).
  {
    const base = mkPost({ image_paths: img(1) });
    const b = await bodyForVisible(base, 1500);
    const { res, calls } = await scenario({ ...base, body_ru: b.ru, body_en: 'Short.' }, 'actionPublish("p1")');
    assert.equal(res.ok, true);
    assert.deepEqual(calls, ['sendRichMessage', 'sendRichMessage']);
  }

  // 4. Entities do not count: raw HTML is over 1024 but the visible text fits, so it stays a photo post.
  {
    const base = mkPost({ image_paths: img(1) });
    const b = await bodyForVisible(base, 1000);
    const amp = s => s.replace(/а/g, '&').replace(/a/g, '&');
    const { res, calls } = await scenario({ ...base, body_ru: amp(b.ru), body_en: amp(b.en) }, 'actionPublish("p1")');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.format, 'post');
    assert.deepEqual(calls, ['sendPhoto', 'sendPhoto']);
  }

  // 5. More than four images cannot go as a media group, so the post becomes an article.
  {
    const { res, calls } = await scenario(mkPost({ image_paths: img(6) }), 'actionPublish("p1")');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.format, 'article');
    assert.deepEqual(calls, ['sendRichMessage', 'sendRichMessage']);
  }

  // 6. Article content: heading, paragraphs, source, inline charts, footer, hashtags; no photo calls.
  {
    const base = mkPost({ image_paths: img(2) });
    const b = await bodyForVisible(base, 1800);
    const { raw, calls } = await scenario({ ...base, body_ru: b.ru, body_en: b.en }, 'actionPublish("p1")');
    const html = raw[0].body.rich_message.html;
    assert.ok(html.startsWith('<h3>Заголовок</h3>'));
    assert.equal((html.match(/<img /g) || []).length, 2);
    assert.ok(html.includes('Источник: <i>Reuters</i>') && html.includes('<footer>') && html.includes('#macro'));
    assert.equal(raw[0].body.message_thread_id, 7);
    assert.ok(!calls.includes('sendPhoto') && !calls.includes('sendMediaGroup'));
  }

  // 7. Failed article send: nothing is persisted as article, republish_missing retries and decides again.
  {
    const base = mkPost({ image_paths: img(1) });
    const b = await bodyForVisible(base, 1500);
    const post = { ...base, body_ru: b.ru, body_en: b.en };
    const failed = await scenario(post, 'actionPublish("p1")', { fail: new Set(['sendRichMessage']) });
    assert.equal(failed.res.error, 'partial_failure');
    assert.equal(failed.state.post.status, 'draft');
    assert.equal(failed.state.post.tg_format, 'post');
    // RU delivered, EN failed: format is stored with the delivered message so retry keeps it.
    const db = fakeDb(post);
    let n = 0;
    const flaky = telegram();
    const ctx = load(db, async (u, i, c) => String(u).includes('sendRichMessage') && ++n === 2
      ? { status: 400, json: async () => ({ ok: false, error_code: 400, description: 'x' }) } : flaky(u, i, c));
    const r1 = JSON.parse(JSON.stringify(await vm.runInContext('actionPublish("p1")', ctx)));
    assert.equal(r1.error, 'partial_failure');
    assert.equal(db.state.post.tg_format, 'article');
    assert.ok(db.state.post.message_id_ru && !db.state.post.message_id_en);
    const r2 = JSON.parse(JSON.stringify(await vm.runInContext('actionRepublishMissing("p1")', ctx)));
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.format, 'article');
    assert.equal(db.state.post.status, 'published');
  }

  // 8. republish_missing on a fresh post decides automatically; with RU already out as a photo post it never switches.
  {
    const base = mkPost({ image_paths: img(1) });
    const b = await bodyForVisible(base, 1500);
    const fresh = await scenario({ ...base, body_ru: b.ru, body_en: b.en }, 'actionRepublishMissing("p1")');
    assert.equal(fresh.res.ok, true);
    assert.deepEqual(fresh.calls, ['sendRichMessage', 'sendRichMessage']);
    const half = await scenario({ ...base, body_ru: b.ru, body_en: b.en, message_id_ru: 55 }, 'actionRepublishMissing("p1")');
    assert.equal(half.res.error, 'caption_too_long', 'already delivered as a photo post keeps its format');
    assert.deepEqual(half.calls, []);
  }

  // 9. Asset posts and explicit text-only posts are not touched.
  {
    const base = mkPost({ image_paths: img(1), ticker: 'NVDA', company_name: 'NVIDIA', destination: 'asset' });
    const b = await bodyForVisible(base, 1500);
    const asset = await scenario({ ...base, body_ru: b.ru, body_en: b.en }, 'actionPublish("p1")');
    assert.equal(asset.res.error, 'caption_too_long');
    assert.deepEqual(asset.calls, []);
    const tl = mkPost({ image_paths: img(1), tg_text_only: true });
    const b2 = await bodyForVisible(tl, 1500);
    const textOnly = await scenario({ ...tl, body_ru: b2.ru, body_en: b2.en }, 'actionPublish("p1")');
    assert.equal(textOnly.res.ok, true, JSON.stringify(textOnly.res));
    assert.deepEqual(textOnly.calls, ['sendMessage', 'sendMessage']);
    assert.equal(textOnly.state.post.tg_format, 'post');
    // the manual article switch on an asset post still works
    const manual = await scenario({ ...base, tg_format: 'article', body_ru: b.ru, body_en: b.en }, 'actionPublish("p1")');
    assert.equal(manual.res.ok, true);
    assert.deepEqual(manual.calls, ['sendRichMessage', 'sendRichMessage']);
  }

  // 10. Too long even for an article: clear error, nothing sent.
  {
    const base = mkPost({ image_paths: img(1) });
    const { res, calls } = await scenario({ ...base, body_ru: words('а', 33000), body_en: 'ok' }, 'actionPublish("p1")');
    assert.equal(res.error, 'article_too_long');
    assert.deepEqual(calls, []);
  }

  // 11. Editing a published post keeps its stored format.
  {
    const base = mkPost({ image_paths: img(1), status: 'published', message_id_ru: 11, message_id_en: 12 });
    const b = await bodyForVisible(base, 1500);
    const art = await scenario({ ...base, tg_format: 'article', body_ru: b.ru, body_en: b.en }, 'actionEdit("p1")');
    assert.equal(art.res.ok, true, JSON.stringify(art.res));
    assert.deepEqual(art.calls, ['editMessageText', 'editMessageText']);
    assert.ok(art.raw[0].body.rich_message.html.includes('<img'));
    const post = await scenario({ ...base, body_ru: b.ru, body_en: b.en }, 'actionEdit("p1")');
    assert.equal(post.res.error, 'caption_too_long');
    assert.match(post.res.hint, /удалите пост из Telegram/);
    assert.deepEqual(post.calls, []);
  }

  // 12. Preview goes only to the admin's private chat and reports the format.
  {
    const base = mkPost({ image_paths: img(1) });
    const b = await bodyForVisible(base, 1500);
    const { res, raw, state } = await scenario({ ...base, body_ru: b.ru, body_en: b.en }, 'actionPreview("p1")');
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.format, 'article');
    assert.ok(raw.every(c => c.body.chat_id === 777 && c.body.message_thread_id === undefined));
    assert.equal(state.post.status, 'draft');
    assert.equal(state.updates.filter(u => 'tg_format' in u).length, 0, 'preview does not persist the format');
  }

  console.log('timeline-auto-format: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
