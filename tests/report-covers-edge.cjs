const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
function load(name, db = {}) {
  const source = fs.readFileSync(`supabase/functions/${name}/index.ts`, 'utf8').replace(/^import .*;\s*$/gm, '');
  const result = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    reportDiagnostics: true,
  });
  assert.equal(result.diagnostics.length, 0, `${name}: TypeScript syntax`);
  const ctx = vm.createContext({
    Deno: { env: { get: k => k === 'SUPABASE_URL' ? 'https://obujqvqqmyfcfflhqvud.supabase.co' : 'test' }, serve: h => ctx.handler = h },
    createClient: () => db, Response, Request, URL, URLSearchParams, TextEncoder,
    console, fetch: () => { throw Error('Unexpected external request'); },
  });
  vm.runInContext(result.outputText, ctx);
  return ctx;
}
(async () => {
  // Compile every deployed edge function, retaining their actual handlers.
  for (const name of ['analytics-save','analytics-get','analytics-list','analytics-publish','analytics-edit-tg','analytics-email-render','research-render','research-list']) load(name);
  let saved;
  const db = { from: () => ({
    update: p => { saved = p; return { eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: { id: 'test' } }) }) }) }; },
  }) };
  const save = load('analytics-save', db);
  async function call(covers) {
    const r = await save.handler(new Request('https://test/', {
      method: 'POST', headers: { 'x-bot-secret': 'test' },
      body: JSON.stringify({ id: 'test', slug: 'test', report_date: '2026-10-27', report_type: 'daily', title_ru: 'Тест', ...covers }),
    }));
    assert.equal(r.status, 200);
    return saved;
  }
  await call({ cover_image_url_ru: 'RU', cover_image_url_en: 'EN', cover_image_url: null });
  assert.equal(saved.cover_image_url_ru, 'RU');
  assert.equal(saved.cover_image_url_en, 'EN');
  await call({ cover_image_url_ru: null, cover_image_url_en: 'EN' });
  assert.equal(saved.cover_image_url_ru, null);
  assert.equal(saved.cover_image_url_en, 'EN');
  await call({ cover_image_url: 'legacy' });
  assert.equal('cover_image_url_ru' in saved, false);
  assert.equal('cover_image_url_en' in saved, false);
  const unauthorized = await save.handler(new Request('https://test/', { method: 'POST', body: '{}' }));
  assert.equal(unauthorized.status, 401);

  const base = 'https://obujqvqqmyfcfflhqvud.supabase.co/storage/v1/object/public/analytics/';
  const report = { id: 'test', slug: 'test', title_ru: 'Тест', title_en: 'Test', report_date: '2026-10-27', cover_image_url: base+'old.png', cover_image_url_ru: base+'ru.png', cover_image_url_en: base+'en.png' };
  const research = load('research-render');
  research.fixture = report;
  for (const lang of ['ru','en']) {
    const card = vm.runInContext(`renderCard(fixture, '${lang}', T.${lang})`, research);
    const page = vm.runInContext(`renderReport('${lang}', fixture, [])`, research);
    assert.ok(card.includes(base + lang + '.png'));
    assert.ok(page.includes(base + lang + '.png'));
    assert.ok(!page.includes(base + (lang === 'ru' ? 'en' : 'ru') + '.png'));
    // Open Graph and the visible hero must use the same language.
    assert.ok(page.includes(`property="og:image" content="${base+lang+'.png'}"`));
  }
  const emailDb = { from: table => ({ select: () => ({ eq: () => table === 'analytics_reports'
    ? { single: async () => ({ data: report }) }
    : { order: async () => ({ data: [] }) } }) }) };
  const email = load('analytics-email-render', emailDb);
  email.db = emailDb;
  for (const lang of ['ru','en']) {
    const r = await vm.runInContext(`fetchReport(db, 'test', '${lang}')`, email);
    assert.equal(r.cover_image_url, base + lang + '.png');
  }
  console.log('Edge execution: compile 8 functions; authenticated save, deletion, old clients, research hero/card/OG and localized email: PASS');
})().catch(e => { console.error(e); process.exit(1); });
