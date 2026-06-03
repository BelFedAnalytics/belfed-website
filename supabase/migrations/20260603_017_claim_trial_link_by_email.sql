-- 20260603_017_claim_trial_link_by_email.sql
--
-- Make claim_trial_by_telegram email-aware:
-- If telegram_id is not found in profiles but p_email matches an existing
-- profile (created e.g. via web signup before telegram link), attach
-- telegram_id to that existing profile rather than creating a duplicate.
--
-- This closes the loop for the new web signup → "link Telegram" UX:
--
--   1. User signs up on web (auth.users INSERT) — handle_new_user creates
--      profile with email, no telegram_id. autostart_trial trigger no longer
--      starts a trial (see migration 016). Profile exists but is "pending".
--   2. User clicks "Link Telegram" deep link → /trial.html-style flow
--      (re-using trial-intent-create with consent already accepted) issues a
--      one-shot token containing the email.
--   3. Bot deep-link → bot-claim-trial(intent_token) → consume_trial_intent
--      returns the email → claim_trial_by_telegram(p_telegram_id, p_email, ...)
--   4. WITH THIS MIGRATION: RPC checks for existing profile by p_email FIRST,
--      and if found (and no telegram_id conflict) — attaches telegram_id to
--      it, starts the trial, and links auth.users.email_confirmed_at.
--   5. UI now sees subscription_status='trial' AND trial_end > now → access.

CREATE OR REPLACE FUNCTION public.claim_trial_by_telegram(
  p_telegram_id text,
  p_telegram_username text DEFAULT NULL::text,
  p_trial_days integer DEFAULT 14,
  p_source text DEFAULT 'telegram_direct'::text,
  p_lang text DEFAULT 'ru'::text,
  p_email text DEFAULT NULL::text,
  p_privacy_consent_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_terms_consent_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_consent_ip text DEFAULT NULL::text,
  p_consent_ua text DEFAULT NULL::text,
  p_consent_locale text DEFAULT NULL::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_user_id uuid;
  v_existing_profile public.profiles%ROWTYPE;
  v_email_profile    public.profiles%ROWTYPE;
  v_email text;
  v_trial_end timestamptz;
  v_now timestamptz := now();
  v_lang text;
  v_email_was_real boolean;
BEGIN
  IF p_telegram_id IS NULL OR p_telegram_id = '' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'telegram_id_required');
  END IF;

  v_lang := COALESCE(NULLIF(p_lang, ''), 'ru');
  IF v_lang NOT IN ('ru','en') THEN v_lang := 'ru'; END IF;

  -- Normalize email
  v_email := CASE WHEN p_email IS NOT NULL AND length(trim(p_email)) > 0
                  THEN lower(trim(p_email)) ELSE NULL END;

  -- Search by telegram_id/username
  v_existing_profile := public.find_profile_by_telegram(p_telegram_id, p_telegram_username);

  -- NEW: if no telegram-side match BUT we have a real email — try matching by email.
  -- This handles the web-signup → link-telegram case.
  IF v_existing_profile.id IS NULL AND v_email IS NOT NULL THEN
    SELECT * INTO v_email_profile
    FROM public.profiles
    WHERE lower(email) = v_email
      AND merged_into_user_id IS NULL
    ORDER BY created_at ASC
    LIMIT 1;

    IF v_email_profile.id IS NOT NULL THEN
      -- Defensive: skip if it already has a different telegram_id
      IF v_email_profile.telegram_id IS NOT NULL
         AND v_email_profile.telegram_id <> ''
         AND v_email_profile.telegram_id <> p_telegram_id THEN
        RETURN jsonb_build_object('ok', false, 'error', 'email_taken',
                                   'user_id', v_email_profile.id,
                                   'lang', COALESCE(v_email_profile.lang, v_lang));
      END IF;
      v_existing_profile := v_email_profile;
    END IF;
  END IF;

  IF v_existing_profile.id IS NOT NULL THEN
    v_email_was_real := v_existing_profile.email IS NOT NULL
                        AND v_existing_profile.email NOT LIKE 'tg\_%@belfed.local' ESCAPE '\';

    -- Attach telegram_id if not yet
    IF v_existing_profile.telegram_id IS NULL OR v_existing_profile.telegram_id !~ '^\d+$' THEN
      UPDATE public.profiles
      SET telegram_id = p_telegram_id,
          telegram_username = COALESCE(p_telegram_username, telegram_username),
          updated_at = v_now
      WHERE id = v_existing_profile.id;
      v_existing_profile.telegram_id := p_telegram_id;
    END IF;

    IF v_existing_profile.subscription_status IN ('active', 'admin') THEN
      IF v_email IS NOT NULL AND NOT v_email_was_real THEN
        UPDATE public.profiles
        SET email = v_email,
            privacy_consent_at = COALESCE(privacy_consent_at, p_privacy_consent_at),
            terms_consent_at   = COALESCE(terms_consent_at,   p_terms_consent_at),
            consent_ip         = COALESCE(consent_ip,         p_consent_ip),
            consent_user_agent = COALESCE(consent_user_agent, p_consent_ua),
            consent_locale     = COALESCE(consent_locale,     p_consent_locale),
            is_lite_profile = false,
            updated_at = v_now
        WHERE id = v_existing_profile.id;
        UPDATE auth.users SET email = v_email, updated_at = v_now WHERE id = v_existing_profile.id;
      END IF;
      RETURN jsonb_build_object(
        'ok', true,
        'user_id', v_existing_profile.id,
        'lang', COALESCE(v_existing_profile.lang, v_lang),
        'status', v_existing_profile.subscription_status,
        'already_active', true,
        'trial_end', v_existing_profile.trial_end,
        'subscription_expires_at', v_existing_profile.subscription_expires_at
      );
    END IF;

    IF v_existing_profile.trial_started_at IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', false,
        'error', 'trial_already_used',
        'user_id', v_existing_profile.id,
        'lang', COALESCE(v_existing_profile.lang, v_lang),
        'trial_end', v_existing_profile.trial_end,
        'subscription_status', v_existing_profile.subscription_status
      );
    END IF;

    v_trial_end := v_now + (p_trial_days || ' days')::interval;
    UPDATE public.profiles
    SET trial_started_at = v_now,
        trial_start = v_now,
        trial_end = v_trial_end,
        subscription_status = 'trial',
        trial_source = COALESCE(trial_source, p_source),
        telegram_username = COALESCE(p_telegram_username, telegram_username),
        lang = COALESCE(lang, v_lang),
        email = CASE WHEN v_email IS NOT NULL AND NOT v_email_was_real THEN v_email ELSE email END,
        is_lite_profile = CASE WHEN v_email IS NOT NULL AND NOT v_email_was_real THEN false ELSE is_lite_profile END,
        privacy_consent_at = COALESCE(privacy_consent_at, p_privacy_consent_at),
        terms_consent_at   = COALESCE(terms_consent_at,   p_terms_consent_at),
        consent_ip         = COALESCE(consent_ip,         p_consent_ip),
        consent_user_agent = COALESCE(consent_user_agent, p_consent_ua),
        consent_locale     = COALESCE(consent_locale,     p_consent_locale),
        updated_at = v_now
    WHERE id = v_existing_profile.id;

    IF v_email IS NOT NULL AND NOT v_email_was_real THEN
      UPDATE auth.users SET email = v_email, updated_at = v_now WHERE id = v_existing_profile.id;
    END IF;

    -- Also confirm email on auth.users for web-signup profiles whose email
    -- wasn't yet confirmed (handles the case where user clicks Telegram link
    -- before clicking the confirmation email).
    UPDATE auth.users
    SET email_confirmed_at = COALESCE(email_confirmed_at, v_now),
        updated_at = v_now
    WHERE id = v_existing_profile.id;

    RETURN jsonb_build_object(
      'ok', true,
      'user_id', v_existing_profile.id,
      'lang', COALESCE(v_existing_profile.lang, v_lang),
      'status', 'trial',
      'trial_end', v_trial_end,
      'created', false,
      'attached_to_existing', NOT v_existing_profile.is_lite_profile
    );
  END IF;

  -- Fall-through: create lite-profile from scratch.
  IF v_email IS NOT NULL THEN
    v_email := lower(v_email);
  ELSE
    v_email := 'tg_' || p_telegram_id || '@belfed.local';
  END IF;
  v_user_id := gen_random_uuid();
  v_trial_end := v_now + (p_trial_days || ' days')::interval;

  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    is_super_admin, is_sso_user
  ) VALUES (
    v_user_id,
    '00000000-0000-0000-0000-000000000000',
    'authenticated', 'authenticated',
    v_email, '',
    v_now, v_now, v_now,
    jsonb_build_object('provider', 'telegram', 'providers', ARRAY['telegram']),
    jsonb_build_object('telegram_id', p_telegram_id,
                       'is_lite', v_email LIKE 'tg\_%@belfed.local' ESCAPE '\',
                       'lang', v_lang),
    false, false
  );

  UPDATE public.profiles
  SET telegram_id = p_telegram_id,
      telegram_username = p_telegram_username,
      subscription_status = 'trial',
      trial_start = v_now,
      trial_started_at = v_now,
      trial_end = v_trial_end,
      is_lite_profile = (v_email LIKE 'tg\_%@belfed.local' ESCAPE '\'),
      trial_source = p_source,
      lang = v_lang,
      privacy_consent_at = p_privacy_consent_at,
      terms_consent_at   = p_terms_consent_at,
      consent_ip         = p_consent_ip,
      consent_user_agent = p_consent_ua,
      consent_locale     = p_consent_locale,
      updated_at = v_now
  WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'user_id', v_user_id,
    'lang', v_lang,
    'status', 'trial',
    'trial_end', v_trial_end,
    'created', true,
    'is_lite', (v_email LIKE 'tg\_%@belfed.local' ESCAPE '\')
  );
EXCEPTION WHEN unique_violation THEN
  SELECT id INTO v_user_id FROM public.profiles WHERE telegram_id = p_telegram_id LIMIT 1;
  RETURN jsonb_build_object('ok', false, 'error', 'race_condition', 'user_id', v_user_id);
END;
$function$;

COMMENT ON FUNCTION public.claim_trial_by_telegram(text,text,integer,text,text,text,timestamptz,timestamptz,text,text,text) IS
  'Email-aware: when telegram_id is new but p_email matches an existing profile (e.g. web-signup), attaches telegram_id + starts trial on that profile instead of creating a duplicate. Also confirms auth.users.email_confirmed_at on success.';
