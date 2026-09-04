const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const migration = read('supabase', 'migrations', '20260904_030_video_review_publish_targets.sql');
const admin = read('admin-video-reviews.html');
const analytics = read('analytics.html');
const telegram = read('supabase', 'functions', 'video-review-publish', 'index.ts');
const email = read('supabase', 'functions', 'video-review-email-send', 'index.ts');

test('migration defines the complete RU/EN by website/Telegram matrix', () => {
  for (const field of [
    'publish_to_site_ru',
    'publish_to_telegram_ru',
    'publish_to_site_en',
    'publish_to_telegram_en',
  ]) assert.match(migration, new RegExp(`${field} boolean not null default false`, 'i'));
  assert.match(migration, /published_at_ru timestamptz/i);
  assert.match(migration, /published_at_en timestamptz/i);
  assert.match(migration, /not \(publish_to_site_ru or publish_to_telegram_ru\)/i);
  assert.match(migration, /not \(publish_to_site_en or publish_to_telegram_en\)/i);
});

test('Telegram topics and durable snapshot claims are localized and fail closed', () => {
  assert.match(migration, /-1003773738299[\s\S]+'ru'[\s\S]+'video_reviews'[\s\S]+3/i);
  assert.match(migration, /-1003869302680[\s\S]+'en'[\s\S]+'video_reviews'[\s\S]+7/i);
  assert.match(migration, /create table if not exists public\.video_review_telegram_attempts/i);
  assert.match(migration, /claim_video_review_telegram_publish\(uuid, text\[\], timestamptz, uuid\)[\s\S]+to service_role/i);
  assert.match(migration, /finish_video_review_telegram_attempt\(uuid, text, jsonb, text\)[\s\S]+to service_role/i);
  assert.match(migration, /unique \(operation_id, lang\)/i);
  assert.match(migration, /where status in \('sending', 'uncertain'\)/i);
  assert.doesNotMatch(migration, /telegram_send_started_at_ru < now/i);
  assert.doesNotMatch(migration, /telegram_send_started_at_en < now/i);
  assert.ok(telegram.indexOf('claim_video_review_telegram_publish') < telegram.indexOf('publishAttempt(claims[lang]'));
  assert.match(telegram, /subscription_status !== "admin"/);
  assert.match(telegram, /p_expected_updated_at: expectedUpdatedAt/);
  assert.match(telegram, /p_operation_id: operationId/);
  assert.match(telegram, /AbortSignal\.timeout\(15_000\)/);
  assert.match(telegram, /response\.ok && !\(parsed && body\?\.ok === false\)/);
  assert.doesNotMatch(telegram, /\.from\("video_reviews"\)[\s\S]*\.select\("\*"\)/);
  assert.match(telegram, /editMessageMedia/);
  assert.match(telegram, /editMessageText/);
  assert.match(
    telegram,
    /cannot remove the cover from an existing Telegram photo post; keep the cover or reconcile manually/,
  );
  assert.match(telegram, /durable attempt \$\{attemptId\} finalization failed/);
});

test('admin publishes targets atomically and supports separate cover uploads', () => {
  for (const field of [
    'publish_to_site_ru',
    'publish_to_telegram_ru',
    'publish_to_site_en',
    'publish_to_telegram_en',
  ]) assert.match(admin, new RegExp(`id="${field}"`));
  assert.match(admin, /thumbnail_file_ru/);
  assert.match(admin, /thumbnail_file_en/);
  assert.match(admin, /storage\.from\('analysis-images'\)\.upload/);
  assert.match(admin, /p\.status='published'/);
  assert.match(admin, /p\[`published_at_\$\{lang\}`\]/);
  assert.match(admin, /newReview\(true\)/);
  assert.match(admin, /Email-рассылка не будет запущена автоматически/);
  assert.doesNotMatch(admin, /publish_to_site_ru\.checked=true/);
  assert.match(admin, /Сессия администратора истекла; Telegram не обновлён/);
  assert.match(admin, /Telegram недоступен:/);
  assert.match(
    admin,
    /Telegram \$\{lang\.toUpperCase\(\)\} уже имеет историю доставки\. Снять этот флаг нельзя; используйте архив/,
  );
  assert.match(admin, /function makeOperation\(\)/);
  assert.match(admin, /operationId:crypto\.randomUUID\(\)/);
  assert.match(admin, /expected_updated_at:row\.updated_at,operation_id:operationId/);
  assert.match(admin, /\.eq\('updated_at',op\.updatedAt\)/);
  assert.match(admin, /function fillEditor\(row\)/);
  assert.match(admin, /if\(fresh&&!dirtyState\)fillEditor\(fresh\)/);
  const editReviewBody = admin.match(/function editReview\(id\)\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(editReviewBody, /loadList\(/);
  assert.match(admin, /dirtyState=false/);
  assert.match(admin, /fresh&&!dirtyState/);
  assert.match(admin, /На сервере появилась новая версия/);
  assert.match(admin, /onclick="requestNewReview\(\)"/);
  assert.match(admin, /function requestNewReview\(\)\{if\(dirtyState&&!confirm\(/);
  assert.match(admin, /event==='SIGNED_IN'\|\|event==='SIGNED_OUT'/);
  assert.doesNotMatch(admin, /onAuthStateChange\(\(\)=>setTimeout\(checkAdmin/);
  assert.match(admin, /function lockDeliveredTargets\(\)/);
  assert.match(admin, /reconcile_video_review_telegram/);
  assert.match(admin, /telegram_send_started_at_\$\{lang\}/);
  assert.match(admin, /function canReconcile\(lang\)/);
  assert.match(admin, /15\*60\*1000/);
  assert.match(migration, /create trigger video_reviews_guard_delivery_history/i);
  assert.match(migration, /video review content cannot change while a delivery is in progress/i);
  assert.match(migration, /video review with delivery history cannot be deleted; archive it instead/i);
  assert.match(migration, /create table if not exists public\.video_review_telegram_reconciliations/i);
  assert.match(migration, /create or replace function public\.reconcile_video_review_telegram/i);
  assert.match(migration, /reconciliation is available after 15 minutes/i);
});

test('RU member catalog uses a locale-scoped RPC without EN fields', () => {
  assert.match(analytics, /function videoLocale\(item\) \{\s*return 'ru';/);
  assert.match(analytics, /\.rpc\('video_reviews_list', \{ p_lang: 'ru' \}\)/);
  assert.match(migration, /drop policy if exists video_reviews_member_read/i);
  assert.match(migration, /create or replace function public\.video_reviews_list\(p_lang text\)/i);
  assert.match(migration, /if p_lang is null or p_lang not in \('ru', 'en'\)/i);
  assert.match(migration, /grant execute on function public\.video_reviews_list\(text\)\s+to authenticated/i);
  assert.doesNotMatch(migration, /grant execute on function public\.video_reviews_list\(text\)\s+to anon/i);
});

test('email campaigns are claimed and finalized independently by subscriber language', () => {
  assert.match(email, /eligibleLangs/);
  assert.match(email, /p_lang: lang/);
  assert.match(email, /claimedLangs\.includes\(lang\)/);
  assert.match(email, /email_sent_at_\$\{lang\}/);
  assert.doesNotMatch(email, /const fallback = lang === "en"/);
  assert.match(migration, /claim_video_review_email_send\(uuid, text\)[\s\S]+to service_role/i);
  assert.match(migration, /drop function if exists public\.claim_video_review_email_send\(uuid\)/i);
});
