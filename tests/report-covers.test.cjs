const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'admin-analytics.html'), 'utf8');

for (const lang of ['ru', 'en']) {
  assert.match(html, new RegExp(`id="dz-cover-${lang}"`));
  assert.match(html, new RegExp(`cover_image_url_${lang}: state.cover_image_url_${lang}`));
  assert.match(html, new RegExp(`state.cover_image_url_${lang} = rep.cover_image_url_${lang} \\|\\| rep.cover_image_url \\|\\| null`));
  assert.match(html, new RegExp(`state.cover_image_url_${lang} = null`));
}
assert.match(html, /cover_image_url: null,/);

// Execute the actual rendering expressions in each surface, not a test-only helper.
for (const page of ['analytics.html', 'analytics-view.html']) {
  const src = fs.readFileSync(path.join(root, page), 'utf8');
  const expression = src.match(/const coverUrl = (.*);/);
  assert.ok(expression, `${page} must resolve the localized cover`);
  const resolve = (r, lang) => vm.runInNewContext(expression[1], { r, state: { lang } });
  const r = { cover_image_url: 'legacy', cover_image_url_ru: 'russian', cover_image_url_en: 'english' };
  assert.equal(resolve(r, 'ru'), 'russian');
  assert.equal(resolve(r, 'en'), 'english');
  assert.equal(resolve({ cover_image_url: 'legacy' }, 'ru'), 'legacy');
  assert.equal(resolve({ cover_image_url: 'legacy' }, 'en'), 'legacy');
  assert.equal(resolve({ cover_image_url_ru: 'russian' }, 'en'), null);
}

// Payload semantics: removing RU never clears EN, nor revives the old shared image.
const build = html.slice(html.indexOf('function buildPayload('), html.indexOf('\n}', html.indexOf('function buildPayload(')) + 2);
const state = {
  sections: [], conclusion: { enabled: false }, cover_image_url_ru: null,
  cover_image_url_en: 'english', asset_classes: [], sectors: [], tags: [],
};
const context = {
  state, document: { getElementById: () => ({ value: '', checked: false }) },
  readPublishMode: () => 'manual', readPublishAfterUtc: () => null,
};
const payload = vm.runInNewContext(`${build}; buildPayload('draft')`, context);
assert.equal(payload.cover_image_url, null);
assert.equal(payload.cover_image_url_ru, null);
assert.equal(payload.cover_image_url_en, 'english');
console.log('Localized report covers: UI, payload, language selection and legacy fallback pass');
