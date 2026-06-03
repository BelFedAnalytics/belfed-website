-- Перепривязываем все child-строки с merged-стабов на canonical-профили.
-- Bug: merge-логика (merge_lite_into_full) ставила profiles.merged_into_user_id,
-- но не перепривязывала subscriptions/payments/subscription_events/feedback_messages/etc.
-- Симптом: в admin_list_subscribers юзеры видны под lite-email (tg_XXX@belfed.local)
-- вместо настоящего, и founding-флаги сев не туда попадут на стабы.

BEGIN;

UPDATE subscriptions s
SET user_id = p.merged_into_user_id, updated_at = now()
FROM profiles p
WHERE s.user_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE payments py
SET user_id = p.merged_into_user_id
FROM profiles p
WHERE py.user_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE subscription_events se
SET user_id = p.merged_into_user_id
FROM profiles p
WHERE se.user_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE feedback_messages fm
SET profile_id = p.merged_into_user_id
FROM profiles p
WHERE fm.profile_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE chart_requests cr
SET user_id = p.merged_into_user_id
FROM profiles p
WHERE cr.user_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE email_subscribers es
SET profile_id = p.merged_into_user_id
FROM profiles p
WHERE es.profile_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE link_tokens lt
SET user_id = p.merged_into_user_id
FROM profiles p
WHERE lt.user_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE telegram_links tl
SET user_id = p.merged_into_user_id
FROM profiles p
WHERE tl.user_id = p.id AND p.merged_into_user_id IS NOT NULL;

UPDATE trial_intents ti
SET profile_id = p.merged_into_user_id
FROM profiles p
WHERE ti.profile_id = p.id AND p.merged_into_user_id IS NOT NULL;

COMMIT;
