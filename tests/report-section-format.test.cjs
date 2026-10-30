// QA for the automatic Telegram format of report sections (analytics-publish v45 and friends).
//   node tests/report-section-format.test.cjs      (TYPESCRIPT_PATH may point at a typescript install)
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');

const FN = ['analytics-publish', 'analytics-republish-section', 'analytics-edit-tg'];
const src = n => fs.readFileSync(`supabase/functions/${n}/index.ts`, 'utf8');
const BEGIN = '// ===== TG_SECTION_FORMAT:BEGIN =====';
const END = '// ===== TG_SECTION_FORMAT:END =====';
const blockOf = text => text.slice(text.indexOf(BEGIN), text.indexOf(END) + END.length);

function load(name, { db = {}, fetchImpl } = {}) {
  const source = src(name).replace(/^import .*;\s*$/gm, '');
  const out = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal(out.diagnostics.length, 0, `${name}: TypeScript syntax`);
  const calls = [];
  const ctx = vm.createContext({
    Deno: { env: { get: k => (k === 'BOT_USERNAME' ? undefined : 'test') }, serve: h => { ctx.handler = h; } },
    createClient: () => db, Response, Request, URL, URLSearchParams, TextEncoder, console, FormData, Blob, setTimeout: (f) => { f(); return 0; },
    fetch: async (url, init) => {
      if (fetchImpl) return fetchImpl(url, init, calls);
      throw Error('Unexpected external request ' + url);
    },
  });
  vm.runInContext(out.outputText, ctx);
  ctx.__calls = calls;
  return ctx;
}

// Telegram fake: records every Bot API call; `fail` is a set of methods that answer 400.
function telegram({ fail = new Set() } = {}) {
  let id = 100;
  const impl = async (url, init, calls) => {
    const m = String(url).match(/api\.telegram\.org\/bot[^/]+\/(\w+)/);
    if (!m) { return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8), headers: { get: () => 'image/png' } }; }
    const method = m[1];
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    else if (init.body && typeof init.body.get === 'function') body = { caption: init.body.get('caption'), media: init.body.get('media') };
    calls.push({ method, body });
    if (fail.has(method)) return { status: 400, json: async () => ({ ok: false, error_code: 400, description: 'Bad Request: test failure' }) };
    return { status: 200, json: async () => ({ ok: true, result: method === 'sendMediaGroup' ? [{ message_id: ++id }] : { message_id: ++id } }) };
  };
  return impl;
}

const report = { report_date: '2026-10-30', slug: 'x', title_ru: 'T', title_en: 'T' };
const mkSection = (bodyLen, charts, extra = {}) => ({
  id: 's1', position: 0, section_label_ru: '01 · ТЕСТ', section_label_en: '01 · TEST',
  headline_ru: 'Заголовок', headline_en: 'Headline',
  body_ru: ('Слово '.repeat(Math.ceil(bodyLen / 6))).slice(0, bodyLen),
  body_en: ('Word '.repeat(Math.ceil(bodyLen / 5))).slice(0, bodyLen),
  chart_images: Array.from({ length: charts }, (_, i) => ({ url: `https://x.supabase.co/storage/v1/object/public/c/${i}.png` })),
  ...extra,
});

(async () => {
  // 1. The format block must be identical in all three functions.
  const blocks = FN.map(n => blockOf(src(n)));
  blocks.forEach((b, i) => assert.ok(b.startsWith(BEGIN) && b.endsWith(END), `${FN[i]}: block markers`));
  assert.equal(blocks[1], blocks[0], 'republish block == publish block');
  assert.equal(blocks[2], blocks[0], 'edit-tg block == publish block');

  // 2. Decision rules and visible length.
  const pub = load('analytics-publish');
  const run = (code, vars = {}) => { Object.assign(pub, vars); return JSON.parse(JSON.stringify(vm.runInContext(code, pub))); };
  const fmtOf = (html, n) => run('chooseSectionFormat(h, n)', { h: html, n }).format;
  assert.equal(fmtOf('a'.repeat(1024), 1), 'photo');
  assert.equal(fmtOf('a'.repeat(1025), 1), 'article');
  assert.equal(fmtOf('a'.repeat(1025), 3), 'article');
  assert.equal(fmtOf('a'.repeat(1025), 0), 'text');
  assert.equal(fmtOf('a'.repeat(4096), 0), 'text');
  assert.equal(fmtOf('a'.repeat(4097), 0), 'article');
  // tags and entities do not count: 1000 visible chars wrapped in markup still fit a caption
  assert.equal(run('tgVisibleLength(h)', { h: '<b>' + 'a&amp;'.repeat(500) + '</b>' }), 1000);
  assert.equal(fmtOf('<b>' + 'a&amp;'.repeat(500) + '</b>\n<a href="https://t.me/x">link</a>', 1), 'photo');

  // 3. Publisher delivery matrix.
  async function deliver(bodyLen, charts, { fail, lang = 'ru', section } = {}) {
    const ctx = load('analytics-publish', { fetchImpl: telegram({ fail }) });
    ctx.report = report; ctx.section = section || mkSection(bodyLen, charts); ctx.lang = lang;
    const res = await vm.runInContext(`(async () => {
      const charts = getCharts(section, lang);
      const caps = buildSectionCaptions(section, 2, 5, lang, false, report);
      const fmt = chooseSectionFormat(caps.full, charts.length);
      const html = fmt.format === 'article' ? buildSectionArticleHtml(caps.parts, charts, lang, report) : null;
      const out = await publishSection(-1001, 7, charts, caps, 50, false, fmt, html);
      return JSON.stringify({ out, fmt, html });
    })()`, ctx);
    return { ...JSON.parse(res), calls: ctx.__calls };
  }
  const methods = r => r.calls.map(c => c.method);

  let r = await deliver(500, 0);
  assert.equal(r.out.format, 'text'); assert.deepEqual(methods(r), ['sendMessage']);

  r = await deliver(3000, 0); // old behaviour: cut at 1024 plus a reply
  assert.equal(r.out.format, 'text'); assert.deepEqual(methods(r), ['sendMessage'], 'no tail reply for 3000 chars without charts');
  assert.ok(r.calls[0].body.text.length > 3000);

  r = await deliver(5000, 0);
  assert.equal(r.out.format, 'article'); assert.equal(r.out.mode, 'article'); assert.deepEqual(methods(r), ['sendRichMessage']);
  assert.ok(!r.html.includes('<img'), 'no charts, no images'); assert.match(r.html, /<h3>Заголовок<\/h3>/);
  assert.deepEqual(r.calls[0].body.reply_parameters, { message_id: 50, allow_sending_without_reply: true });
  assert.equal(r.calls[0].body.message_thread_id, 7);

  r = await deliver(600, 1);
  assert.equal(r.out.format, 'photo'); assert.deepEqual(methods(r), ['sendPhoto']);

  r = await deliver(600, 3);
  assert.equal(r.out.format, 'photo'); assert.deepEqual(methods(r), ['sendMediaGroup']);

  r = await deliver(1500, 1);
  assert.equal(r.out.format, 'article'); assert.deepEqual(methods(r), ['sendRichMessage'], 'one chart + long text = single article');
  assert.equal((r.html.match(/<figure>/g) || []).length, 1);
  assert.ok(r.html.indexOf('<h3>') < r.html.indexOf('<figure>'), 'text before the chart (layout B2)');
  assert.match(r.html, /<footer>· Часть 4\/6  <a href="https:\/\/t\.me\/BelfedBot">@BelfedBot<\/a><\/footer>/);

  r = await deliver(1500, 3, { lang: 'en' });
  assert.deepEqual(methods(r), ['sendRichMessage'], 'album of 3 + long text = single article');
  assert.equal((r.html.match(/<figure>/g) || []).length, 3);
  assert.match(r.html, /Part 4\/6/);

  // 4. Article failure -> previous behaviour, with the reason recorded.
  r = await deliver(1500, 1, { fail: new Set(['sendRichMessage']) });
  assert.deepEqual(methods(r), ['sendRichMessage', 'sendPhoto', 'sendMessage'], 'fallback: caption + reply with the tail');
  assert.equal(r.out.format, 'photo'); assert.match(r.out.fallback_reason, /^article_send_failed/);
  assert.ok(r.out.photo_msg_id && r.out.body_msg_id);

  r = await deliver(5000, 0, { fail: new Set(['sendRichMessage']) });
  assert.deepEqual(methods(r), ['sendRichMessage', 'sendMessage', 'sendMessage'], 'fallback without charts: 4096-char message plus the tail');
  assert.equal(r.out.format, 'text'); assert.ok(r.out.fallback_reason);

  // 5. Oversized article never reaches Telegram as an article.
  r = await deliver(33000, 1);
  assert.equal(r.out.format, 'photo'); assert.match(r.out.fallback_reason, /^article_too_long/);
  assert.ok(!methods(r).includes('sendRichMessage'));

  // 6. HTML in text is escaped inside the article, ampersands count once.
  r = await deliver(0, 1, { section: mkSection(0, 1, { body_ru: 'A & B <tag> '.repeat(150) }) });
  assert.equal(r.out.format, 'article');
  assert.ok(r.html.includes('A &amp; B &lt;tag&gt;') && !r.html.includes('<tag>'));

  // 7. Conclusion keeps the full footer; linked section keeps its link.
  {
    const ctx = load('analytics-publish'); ctx.report = report;
    ctx.section = mkSection(1500, 1, { is_conclusion: true, extra_html: '<a href="https://t.me/c/1/2/3">→ В ЛЕНТЕ</a>' });
    const html = vm.runInContext(`(() => { const caps = buildSectionCaptions(section, 4, 5, 'ru', true, report); return buildSectionArticleHtml(caps.parts, getCharts(section,'ru'), 'ru', report); })()`, ctx);
    assert.match(html, /ГЛАВНЫЙ ВЫВОД<br>· BELFED ANALYTICS · 30 окт 2026 · <a href="https:\/\/t\.me\/BelfedBot">@BelfedBot<\/a> · belfed\.ru<\/footer>/);
    assert.ok(html.includes('<p><a href="https://t.me/c/1/2/3">→ В ЛЕНТЕ</a></p>'));
  }

  // 8. republish-section uses the same decision.
  for (const [bodyLen, charts, expect] of [[3000, 0, ['sendMessage']], [5000, 0, ['sendRichMessage']], [1500, 2, ['sendRichMessage']], [500, 1, ['sendPhoto']]]) {
    const ctx = load('analytics-republish-section', { fetchImpl: telegram() });
    const section = mkSection(bodyLen, charts);
    ctx.report = { ...report, tg_message_ids_ru: { chat_id: -1001, thread_id: 7, cover: 9 } }; ctx.section = section;
    const out = JSON.parse(await vm.runInContext(`publishOneSection(report, [section], section, 0, 'ru', false, 9).then(JSON.stringify)`, ctx));
    assert.deepEqual(ctx.__calls.map(c => c.method), expect, `republish ${bodyLen}/${charts}`);
    assert.ok(out.ok);
  }

  // 9. edit-tg: article stays an article, text stays text (4096), linked skipped.
  {
    const sections = [
      { ...mkSection(5000, 0), id: 'a', position: 0 },
      { ...mkSection(3000, 0), id: 'b', position: 1 },
      { ...mkSection(600, 1), id: 'c', position: 2 },
      { ...mkSection(0, 0), id: 'd', position: 3, linked_post_id: 'p1', body_ru: '' },
      { ...mkSection(2000, 1), id: 'e', position: 4 },
    ];
    const rep = { ...report, cover_image_url: null, tg_message_ids_ru: { chat_id: -1001, cover: 9, sections: [
      { section_id: 'a', position: 0, photo_msg_id: 11, mode: 'article' },
      { section_id: 'b', position: 1, photo_msg_id: 12, mode: 'no_photo_text_only' },
      { section_id: 'c', position: 2, photo_msg_id: 13, mode: 'single_photo_caption' },
      { section_id: 'd', position: 3, photo_msg_id: 14, mode: 'single_photo_caption' },
      { section_id: 'e', position: 4, photo_msg_id: 15, mode: 'single_photo_caption' },
    ] } };
    const q = (table) => {
      const chain = { select: () => chain, eq: () => chain, order: async () => ({ data: sections }), maybeSingle: async () => ({ data: rep }) };
      return chain;
    };
    const ctx = load('analytics-edit-tg', { db: { from: q }, fetchImpl: telegram() });
    const res = await ctx.handler(new Request('https://x/f', { method: 'POST', headers: { 'x-bot-secret': 'test' }, body: JSON.stringify({ report_id: 'r', langs: ['ru'] }) }));
    const json = await res.json();
    assert.equal(json.ok, true);
    const st = json.edit_status.ru.sections;
    assert.deepEqual(st.map(s => s.format || s.skipped), ['article', 'text', 'photo', 'linked_section', 'photo']);
    assert.equal(st[4].note, 'republish_needed');
    const calls = ctx.__calls.filter(c => c.body && c.body.message_id);
    assert.ok(calls.find(c => c.body.message_id === 11 && c.method === 'editMessageText' && c.body.rich_message.html.includes('<h3>')));
    const t = calls.find(c => c.body.message_id === 12); assert.equal(t.method, 'editMessageText'); assert.ok(t.body.text.length > 3000);
    assert.ok(calls.find(c => c.body.message_id === 13 && c.method === 'editMessageCaption'));
    assert.ok(!calls.find(c => c.body.message_id === 14));
    const e = calls.find(c => c.body.message_id === 15); assert.equal(e.method, 'editMessageCaption'); assert.ok(e.body.caption.length <= 1024);
  }


  // 10. The editor counter mirrors the publisher: same visible length and same format for many inputs.
  {
    const html = fs.readFileSync('admin-analytics.html', 'utf8');
    const m = html.match(/\/\/ TG_FMT:BEGIN([\s\S]*?)\/\/ TG_FMT:END/);
    assert.ok(m, 'editor format block present');
    const ed = vm.createContext({});
    vm.runInContext(m[1].replace(/\bconst (\w+) =/g, 'var $1 ='), ed);
    const bodies = ['', 'Коротко.', 'A & B <c> "q" '.repeat(40), 'Абзац один.\n\nАбзац два. '.repeat(80), 'x'.repeat(1900), 'y'.repeat(4500), 'z'.repeat(9000)];
    const heads = ['', 'Заголовок', 'Тест', 'ТЕСТ  '];
    const serverCtx = load('analytics-publish'); serverCtx.report = report;
    let n = 0;
    for (const lang of ['ru', 'en']) for (const body of bodies) for (const head of heads) for (const charts of [0, 1, 3]) for (const conclusion of [false, true]) {
      const sec = { ...mkSection(0, charts), [`body_${lang}`]: body, [`headline_${lang}`]: head, [`section_label_${lang}`]: conclusion ? '' : '01 · Тест' };
      const idx = 3, total = 9;
      const label = conclusion ? (lang === 'ru' ? 'ГЛАВНЫЙ ВЫВОД' : 'KEY TAKEAWAY') : sec[`section_label_${lang}`];
      const clientText = vm.runInContext('tgSectionText(f)', Object.assign(ed, { f: { lang, idx, total, isConclusion: conclusion, date: '2026-10-30', label, headline: head, body } }));
      serverCtx.sec = { ...sec, section_label_ru: label, section_label_en: label, is_conclusion: conclusion };
      const server = JSON.parse(vm.runInContext(`(() => { const c = buildSectionCaptions(sec, ${idx}, ${total}, '${lang}', ${conclusion}, report); const f = chooseSectionFormat(c.full, ${charts}); return JSON.stringify({ len: f.len, format: f.format }); })()`, serverCtx));
      const client = vm.runInContext('tgChooseFormat(t.length, c)', Object.assign(ed, { t: clientText, c: charts }));
      assert.equal(client.len, server.len, `visible length ${lang} body=${body.length} head="${head}" charts=${charts} conclusion=${conclusion}`);
      assert.equal(client.format, server.format);
      n++;
    }
    assert.ok(n > 300);
  }

  console.log('report-section-format: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
