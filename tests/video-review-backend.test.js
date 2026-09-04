const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260904_029_video_reviews.sql'),
  'utf8',
);
const preferences = fs.readFileSync(
  path.join(root, 'supabase/functions/email-preferences/index.ts'),
  'utf8',
);
const sender = fs.readFileSync(
  path.join(root, 'supabase/functions/video-review-email-send/index.ts'),
  'utf8',
);

test('migration keeps video email notifications explicit opt-in', () => {
  assert.match(migration, /notify_video_reviews boolean not null default false/i);
  assert.match(migration, /es\.notify_video_reviews = true/i);
});

test('recipient RPC enforces access and both unsubscribe contours', () => {
  assert.match(migration, /public\.user_has_access\(es\.profile_id\)/i);
  assert.match(migration, /es\.unsubscribed_at is null/i);
  assert.match(migration, /coalesce\(p\.email_opt_out, false\) = false/i);
  assert.match(migration, /grant execute on function public\.video_review_email_recipients\(\) to service_role/i);
  assert.doesNotMatch(migration, /grant execute on function public\.video_review_email_recipients\(\) to anon/i);
  assert.match(migration, /lower\(btrim\(p\.email\)\)/i);
  assert.match(migration, /p\.unsubscribe_token::text/i);
  assert.match(migration, /set search_path = pg_catalog, public/i);
});

test('preferences expose the new flag with a false fallback', () => {
  assert.match(preferences, /"notify_video_reviews"/);
  assert.match(preferences, /f === "notify_video_reviews" \? false : true/);
});

test('sender is admin-only, claimed before delivery and RFC 8058 compliant', () => {
  assert.match(sender, /subscription_status !== "admin"/);
  assert.match(sender, /claim_video_review_email_send/);
  assert.match(sender, /status: "queued"/);
  assert.ok(sender.indexOf('status: "queued"') < sender.indexOf('await sendBrevo'));
  assert.match(sender, /List-Unsubscribe-Post/);
  assert.match(sender, /video_review_email_recipients/);
  assert.match(sender, /email_sent_at/);
  assert.match(sender, /attempt < 3/);
  assert.match(sender, /"idempotencyKey": idempotencyKey/);
});

test('migration makes campaign and recipient claims durable', () => {
  assert.match(migration, /email_send_started_at timestamptz/i);
  assert.match(migration, /claim_video_review_email_send/i);
  assert.match(migration, /or video_review_id is not null/i);
  assert.match(migration, /email_sends_video_review_subscriber_uniq/i);
  assert.match(migration, /status <> 'published' or/i);
});

test('preferences synchronize global opt-out and authoritative email', () => {
  assert.match(preferences, /email_opt_out/);
  assert.match(preferences, /emailBlacklisted/);
  assert.match(preferences, /set_email_global_preference/);
  assert.match(migration, /email_opt_out_at = case when p_enabled/i);
  assert.match(preferences, /email: profile\.email\.trim\(\)\.toLowerCase\(\)/);
  assert.match(preferences, /admin\.rpc\([\s\S]+const brevo = await syncBrevoBlacklist/);
  assert.match(preferences, /unsubscribed_at: hasEnabledField && body\.enabled === false/);
  assert.match(preferences, /invalid_body/);
});
