// Edge execution QA for localized section charts (url_en).
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
function load(name, db = {}) {
  const source = fs.readFileSync(`supabase/functions/${name}/index.ts`, 'utf8').replace(/^import .*;\s*$/gm, '');
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
  assert.equal(result.diagnostics.length, 0, `${name}: TypeScript syntax`);
  const ctx = vm.createContext({
    Deno: { env: { get: k => k === 'SUPABASE_URL' ? 'https://obujqvqqmyfcfflhqvud.supabase.co' : 'test' }, serve: h => ctx.handler = h },
    createClient: () => db, Response, Request, URL, URLSearchParams, TextEncoder, console,
    fetch: () => { throw Error('Unexpected external request'); },
  });
  vm.runInContext(result.outputText, ctx);
  return ctx;
}
(async () => {
  for (const name of ['analytics-save','analytics-publish','analytics-republish-section','analytics-edit-tg','analytics-email-render','research-render']) load(name);
  const save = load('analytics-save');
  save.input = [
    { url: 'RU1', url_en: 'EN1', caption_ru: 'a', caption_en: 'b' },
    { url: 'RU2', url_en: '  ', caption_ru: '', caption_en: '' },
    { url: 'RU3', url_en: 'RU3' },
    { url: 'RU4' },
  ];
  const n = JSON.parse(JSON.stringify(vm.runInContext('normalizeChartImages(input)', save)));
  assert.deepEqual(n, [
    { url: 'RU1', url_en: 'EN1', caption_ru: 'a', caption_en: 'b' },
    { url: 'RU2', caption_ru: '', caption_en: '' },
    { url: 'RU3', caption_ru: '', caption_en: '' },
    { url: 'RU4', caption_ru: '', caption_en: '' },
  ]);
  const section = { chart_images: [{ url: 'RU1', url_en: 'EN1' }, { url: 'RU2' }] };
  for (const name of ['analytics-publish','analytics-republish-section']) {
    const c = load(name); c.section = section;
    const urls = l => JSON.parse(JSON.stringify(vm.runInContext(`getCharts(section, '${l}')`, c))).map(x => x.url);
    assert.deepEqual(urls('ru'), ['RU1','RU2'], name);
    assert.deepEqual(urls('en'), ['EN1','RU2'], name);
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext('getCharts(section)', c))).map(x => x.url), ['RU1','RU2'], `${name} default`);
    c.legacy = { chart_image_url: 'OLD' };
    assert.deepEqual(JSON.parse(JSON.stringify(vm.runInContext(`getCharts(legacy, 'en')`, c))).map(x => x.url), ['OLD']);
  }
  // Every Telegram media call site passes the language.
  for (const name of ['analytics-publish','analytics-republish-section']) {
    const src = fs.readFileSync(`supabase/functions/${name}/index.ts`, 'utf8');
    assert.equal((src.match(/const charts = getCharts\(section\);/g) || []).length, 0, `${name}: language-agnostic chart call`);
  }
  // Research page and teaser thumbnails.
  const research = load('research-render');
  research.fixture = { id: 't', slug: 't', title_ru: 'Т', title_en: 'T', report_date: '2026-10-29' };
  const base = 'https://obujqvqqmyfcfflhqvud.supabase.co/storage/v1/object/public/analytics/';
  research.secs = [{ position: 0, is_public: true, section_label_ru: '01', section_label_en: '01', headline_ru: 'А', headline_en: 'A', body_ru: 'x', body_en: 'x',
    chart_images: [{ url: base + 'ru.png', url_en: base + 'en.png', caption_ru: 'р', caption_en: 'e' }, { url: base + 'shared.png' }] }];
  for (const lang of ['ru','en']) {
    const page = vm.runInContext(`renderReport('${lang}', fixture, secs)`, research);
    assert.ok(page.includes(base + lang + '.png'), `research ${lang}`);
    assert.ok(!page.includes(base + (lang === 'ru' ? 'en' : 'ru') + '.png'), `research ${lang} excludes other`);
    assert.ok(page.includes(base + 'shared.png'));
  }
  // Email render for each language.
  const report = { id: 't', slug: 't', title_ru: 'Т', title_en: 'T', report_date: '2026-10-29' };
  const emailDb = { from: table => ({ select: () => ({ eq: () => table === 'analytics_reports'
    ? { single: async () => ({ data: report }) }
    : { order: async () => ({ data: research.secs }) } }) }) };
  const email = load('analytics-email-render', emailDb); email.db = emailDb;
  for (const lang of ['ru','en']) {
    const r = await vm.runInContext(`fetchReport(db, 't', '${lang}')`, email);
    assert.deepEqual(JSON.parse(JSON.stringify(r.sections[0].charts)).map(c => c.url), [base + lang + '.png', base + 'shared.png'], `email ${lang}`);
  }
  // Member page and preview pick the language version on both domains.
  for (const root of ['.', '../belfed-com']) {
    const view = fs.readFileSync(`${root}/analytics-view.html`, 'utf8');
    assert.match(view, /state\.lang === 'en' && c\.url_en \? c\.url_en : c\.url/, `${root} analytics-view`);
  }
  console.log('Section charts edge: save normalization, TG publish/republish per language, legacy fallback, research page, email, member view: PASS');
})().catch(e => { console.error(e); process.exit(1); });
