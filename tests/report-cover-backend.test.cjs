const fs = require('node:fs');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const read = name => fs.readFileSync(`supabase/functions/${name}/index.ts`, 'utf8');
for (const name of ['analytics-get', 'analytics-list', 'analytics-email-render', 'research-render', 'research-list']) {
  for (const lang of ['ru', 'en']) assert.ok(read(name).includes(`cover_image_url_${lang}`), `${name}: select ${lang} cover`);
}
assert.match(read('analytics-save'), /body\[key\] !== undefined/);
assert.match(read('analytics-save'), /reportPayload\[key\] = body\[key\] \|\| null/);
for (const name of ['analytics-publish', 'analytics-edit-tg']) {
  assert.ok(read(name).includes('report[`cover_image_url_${lang}`] || report.cover_image_url'));
}
const publish = read('analytics-publish');
assert.match(publish, /cover_image_url: coverUrl/);
assert.match(publish, /tgSendPhotoUrl\(topic.chat_id, topic.thread_id, coverUrl,/);
const renderer = read('research-render');
assert.match(renderer, /safeImg\(r\[`cover_image_url_\$\{lang\}`\] \|\| r.cover_image_url\)/);
const email = read('analytics-email-render');
const expr = email.match(/cover_image_url: (r\[`cover_image_url_\$\{lang\}`\].*),/)[1];
for (const lang of ['ru', 'en']) {
  assert.equal(vm.runInNewContext(expr, { r: { cover_image_url: 'old' }, lang }), 'old');
  assert.equal(vm.runInNewContext(expr, { r: { cover_image_url_ru: 'RU', cover_image_url_en: 'EN' }, lang }), lang.toUpperCase());
}
console.log('Localized covers: backend selection, save compatibility, Telegram, research and email pass');
