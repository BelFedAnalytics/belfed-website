-- 20260713_026_attribution_conversion.sql
-- =========================================================================
-- Threads / paid-acquisition conversion attribution — source of truth.
--
-- End-to-end funnel: landing UTM → anonymous session → signup (trial-intent)
-- → trial claim (Telegram) → payment. Each stage writes ONE idempotent row to
-- public.conversion_attribution keyed by a stable event_key, so replays
-- (double webhook, retried bot claim, resent form) never duplicate a
-- conversion.
--
-- PII rule: conversion_attribution stores ONLY pseudonymous anonymous_id +
-- allowlisted UTM/referrer/landing_page. Email / telegram_id / names never
-- land here. The browser (belfed-attribution.js) and the edge functions
-- (_shared/attribution.ts) both sanitize; this migration is the last line of
-- defense at the DB boundary.
--
-- Idempotent: safe to re-run. Uses CREATE ... IF NOT EXISTS / ADD COLUMN IF
-- NOT EXISTS throughout so it applies cleanly against the live DB where
-- trial_intents already exists (it is not created by any repo migration).
--
-- !!! REVIEW BEFORE DEPLOY — apply_successful_payment !!!
-- The repo's migration history for apply_successful_payment is BEHIND the
-- deployed function (the live version is provider-aware and upserts a
-- provider-scoped subscriptions row; the last repo copy in
-- 20260424_002 is not). Section E below CREATE-OR-REPLACEs it with a faithful
-- provider-aware reconstruction (mirroring apply_stars_payment from
-- 20260603_011) PLUS the new payment-attribution write. A maintainer MUST diff
-- Section E against the live body (select pg_get_functiondef('public.apply_successful_payment'::regproc))
-- and, if they differ, port ONLY the marked "attribution" block into the live
-- function instead of applying Section E wholesale. record_payment_attribution
-- (Section D) is standalone and safe to apply on its own.
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- A) conversion_attribution — one idempotent row per funnel event
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversion_attribution (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  anonymous_id    text,
  attribution_key text,
  event_type      text NOT NULL,          -- 'signup' | 'trial' | 'payment'
  event_key       text,                   -- idempotency handle (see ux index)
  utm_source      text,
  utm_medium      text,
  utm_campaign    text,
  utm_content     text,
  utm_term        text,
  referrer        text,
  landing_page    text,
  value           numeric(12,2),          -- payment value (null for signup/trial)
  currency        text,
  metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- Defensive ALTERs — in case the table already exists in the live DB with an
-- older shape (these are no-ops when the column is already present).
ALTER TABLE public.conversion_attribution
  ADD COLUMN IF NOT EXISTS profile_id      uuid,
  ADD COLUMN IF NOT EXISTS anonymous_id    text,
  ADD COLUMN IF NOT EXISTS attribution_key text,
  ADD COLUMN IF NOT EXISTS event_type      text,
  ADD COLUMN IF NOT EXISTS event_key       text,
  ADD COLUMN IF NOT EXISTS utm_source      text,
  ADD COLUMN IF NOT EXISTS utm_medium      text,
  ADD COLUMN IF NOT EXISTS utm_campaign    text,
  ADD COLUMN IF NOT EXISTS utm_content     text,
  ADD COLUMN IF NOT EXISTS utm_term        text,
  ADD COLUMN IF NOT EXISTS referrer        text,
  ADD COLUMN IF NOT EXISTS landing_page    text,
  ADD COLUMN IF NOT EXISTS value           numeric(12,2),
  ADD COLUMN IF NOT EXISTS currency        text,
  ADD COLUMN IF NOT EXISTS metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at      timestamptz NOT NULL DEFAULT now();

-- Idempotency: at most one row per non-null event_key.
CREATE UNIQUE INDEX IF NOT EXISTS ux_conversion_attribution_event_key
  ON public.conversion_attribution(event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversion_attribution_profile
  ON public.conversion_attribution(profile_id);
CREATE INDEX IF NOT EXISTS idx_conversion_attribution_anon
  ON public.conversion_attribution(anonymous_id);

-- RLS: internal analytics table. service_role bypasses RLS; nobody else reads.
ALTER TABLE public.conversion_attribution ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversion_attribution FROM anon, authenticated;
-- (no policies → anon/authenticated get no access; edge fns use service_role)

-- -------------------------------------------------------------------------
-- B) trial_intents — attach attribution to the signup intent
-- -------------------------------------------------------------------------
-- trial_intents already exists in the live DB (created out-of-band; referenced
-- by migrations 001/008/009 and bot.py). CREATE IF NOT EXISTS is a safety net
-- for fresh environments; the ADD COLUMN IF NOT EXISTS lines are the real work.
CREATE TABLE IF NOT EXISTS public.trial_intents (
  token       text PRIMARY KEY,
  email       text,
  lang        text,
  source      text,
  intent_type text,
  profile_id  uuid,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.trial_intents
  ADD COLUMN IF NOT EXISTS anonymous_id    text,
  ADD COLUMN IF NOT EXISTS attribution_key text,
  ADD COLUMN IF NOT EXISTS first_touch     jsonb,
  ADD COLUMN IF NOT EXISTS last_touch      jsonb,
  ADD COLUMN IF NOT EXISTS landing_page    text;

-- -------------------------------------------------------------------------
-- C) record_conversion_event — single idempotent writer (SECURITY DEFINER)
-- -------------------------------------------------------------------------
-- Every stage funnels through here. ON CONFLICT DO NOTHING on event_key makes
-- replays harmless. UTM columns are populated from p_touch (an already-
-- sanitized jsonb touch) so a repeated call cannot mutate an existing row.
CREATE OR REPLACE FUNCTION public.record_conversion_event(
  p_event_type      text,
  p_event_key       text,
  p_profile_id      uuid    DEFAULT NULL,
  p_anonymous_id    text    DEFAULT NULL,
  p_attribution_key text    DEFAULT NULL,
  p_touch           jsonb   DEFAULT NULL,
  p_landing_page    text    DEFAULT NULL,
  p_value           numeric DEFAULT NULL,
  p_currency        text    DEFAULT NULL,
  p_metadata        jsonb   DEFAULT '{}'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_id uuid;
  v_t  jsonb := COALESCE(p_touch, '{}'::jsonb);
BEGIN
  IF p_event_type IS NULL OR p_event_type = '' THEN
    RAISE EXCEPTION 'event_type_required';
  END IF;

  INSERT INTO public.conversion_attribution (
    profile_id, anonymous_id, attribution_key, event_type, event_key,
    utm_source, utm_medium, utm_campaign, utm_content, utm_term,
    referrer, landing_page, value, currency, metadata
  ) VALUES (
    p_profile_id,
    NULLIF(p_anonymous_id, ''),
    NULLIF(p_attribution_key, ''),
    p_event_type,
    NULLIF(p_event_key, ''),
    NULLIF(v_t->>'utm_source', ''),
    NULLIF(v_t->>'utm_medium', ''),
    NULLIF(v_t->>'utm_campaign', ''),
    NULLIF(v_t->>'utm_content', ''),
    NULLIF(v_t->>'utm_term', ''),
    NULLIF(v_t->>'referrer', ''),
    COALESCE(NULLIF(p_landing_page, ''), NULLIF(v_t->>'landing_page', '')),
    p_value,
    NULLIF(p_currency, ''),
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (event_key) WHERE event_key IS NOT NULL
  DO NOTHING
  RETURNING id INTO v_id;

  RETURN v_id;  -- NULL when the event already existed (idempotent no-op)
END;
$function$;

REVOKE ALL ON FUNCTION public.record_conversion_event(text,text,uuid,text,text,jsonb,text,numeric,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_conversion_event(text,text,uuid,text,text,jsonb,text,numeric,text,jsonb) TO service_role;

-- --- C.1) record_signup_attribution — called by trial-intent-create ---------
-- Persists the sanitized attribution onto the trial_intent row AND writes the
-- 'signup' conversion event (event_key 'trial-intent:<token>').
CREATE OR REPLACE FUNCTION public.record_signup_attribution(
  p_token           text,
  p_anonymous_id    text,
  p_attribution_key text,
  p_first_touch     jsonb,
  p_last_touch      jsonb,
  p_landing_page    text,
  p_profile_id      uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_touch jsonb := COALESCE(p_last_touch, p_first_touch);
BEGIN
  IF p_token IS NULL OR p_token = '' THEN
    RAISE EXCEPTION 'token_required';
  END IF;

  -- Attach attribution to the intent (no-op-safe if the row isn't there yet).
  UPDATE public.trial_intents
     SET anonymous_id    = COALESCE(NULLIF(p_anonymous_id, ''), anonymous_id),
         attribution_key = COALESCE(NULLIF(p_attribution_key, ''), attribution_key),
         first_touch     = COALESCE(p_first_touch, first_touch),
         last_touch      = COALESCE(p_last_touch, last_touch),
         landing_page    = COALESCE(NULLIF(p_landing_page, ''), landing_page)
   WHERE token = p_token;

  RETURN public.record_conversion_event(
    p_event_type      => 'signup',
    p_event_key       => 'trial-intent:' || p_token,
    p_profile_id      => p_profile_id,
    p_anonymous_id    => p_anonymous_id,
    p_attribution_key => p_attribution_key,
    p_touch           => v_touch,
    p_landing_page    => p_landing_page
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_signup_attribution(text,text,text,jsonb,jsonb,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_signup_attribution(text,text,text,jsonb,jsonb,text,uuid) TO service_role;

-- --- C.2) link_trial_intent_attribution — called by bot-claim-trial ---------
-- After the bot resolves the trial to a user, bind the intent to that profile
-- and write the 'trial' conversion event (event_key 'trial-claim:<token>'),
-- inheriting UTM from the touch captured at signup time.
CREATE OR REPLACE FUNCTION public.link_trial_intent_attribution(
  p_token   text,
  p_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_intent public.trial_intents%ROWTYPE;
  v_touch  jsonb;
BEGIN
  IF p_token IS NULL OR p_token = '' OR p_user_id IS NULL THEN
    RETURN NULL;  -- nothing to link; not an error for the caller
  END IF;

  SELECT * INTO v_intent FROM public.trial_intents WHERE token = p_token;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  UPDATE public.trial_intents
     SET profile_id = COALESCE(profile_id, p_user_id)
   WHERE token = p_token;

  v_touch := COALESCE(v_intent.last_touch, v_intent.first_touch);

  RETURN public.record_conversion_event(
    p_event_type      => 'trial',
    p_event_key       => 'trial-claim:' || p_token,
    p_profile_id      => p_user_id,
    p_anonymous_id    => v_intent.anonymous_id,
    p_attribution_key => v_intent.attribution_key,
    p_touch           => v_touch,
    p_landing_page    => v_intent.landing_page
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.link_trial_intent_attribution(text,uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.link_trial_intent_attribution(text,uuid) TO service_role;

-- -------------------------------------------------------------------------
-- D) record_payment_attribution — idempotent 'payment' conversion event
-- -------------------------------------------------------------------------
-- Standalone + safe to apply on its own. Inherits UTM from the profile's most
-- recent signup/trial conversion event (last-touch attribution of the paying
-- profile). Idempotent on event_key '<provider>:<provider_payment_id>' so a
-- replayed webhook cannot double-count revenue.
CREATE OR REPLACE FUNCTION public.record_payment_attribution(
  p_provider            text,
  p_provider_payment_id text,
  p_profile_id          uuid,
  p_value               numeric,
  p_currency            text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_prior public.conversion_attribution%ROWTYPE;
  v_touch jsonb := '{}'::jsonb;
  v_anon  text;
  v_akey  text;
  v_land  text;
BEGIN
  IF p_provider IS NULL OR p_provider = ''
     OR p_provider_payment_id IS NULL OR p_provider_payment_id = '' THEN
    RETURN NULL;
  END IF;

  -- Inherit attribution from the paying profile's latest signup/trial event.
  SELECT * INTO v_prior
  FROM public.conversion_attribution
  WHERE profile_id = p_profile_id
    AND event_type IN ('signup', 'trial')
  ORDER BY created_at DESC
  LIMIT 1;

  IF FOUND THEN
    v_touch := jsonb_strip_nulls(jsonb_build_object(
      'utm_source',   v_prior.utm_source,
      'utm_medium',   v_prior.utm_medium,
      'utm_campaign', v_prior.utm_campaign,
      'utm_content',  v_prior.utm_content,
      'utm_term',     v_prior.utm_term,
      'referrer',     v_prior.referrer
    ));
    v_anon := v_prior.anonymous_id;
    v_akey := v_prior.attribution_key;
    v_land := v_prior.landing_page;
  END IF;

  RETURN public.record_conversion_event(
    p_event_type      => 'payment',
    p_event_key       => p_provider || ':' || p_provider_payment_id,
    p_profile_id      => p_profile_id,
    p_anonymous_id    => v_anon,
    p_attribution_key => v_akey,
    p_touch           => v_touch,
    p_landing_page    => v_land,
    p_value           => p_value,
    p_currency        => p_currency
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.record_payment_attribution(text,text,uuid,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.record_payment_attribution(text,text,uuid,numeric,text) TO service_role;

-- -------------------------------------------------------------------------
-- E) apply_successful_payment — provider-aware + payment attribution
-- -------------------------------------------------------------------------
-- !!! RECONCILE WITH THE DEPLOYED BODY BEFORE APPLYING (see header note). !!!
-- This reconstruction mirrors the sibling apply_stars_payment (20260603_011):
-- idempotent payment upsert, trial-aware access extension, provider-scoped
-- subscriptions upsert. The ONLY genuinely new behavior is the marked
-- "ATTRIBUTION" block, which records the idempotent 'payment' conversion event.
-- If the live body differs from this, port ONLY that block into it.
CREATE OR REPLACE FUNCTION public.apply_successful_payment(
  p_provider_payment_id text,
  p_user_id             uuid,
  p_amount              numeric,
  p_currency            text,
  p_plan                text,
  p_period_months       integer,
  p_paid_at             timestamptz,
  p_raw                 jsonb,
  p_is_test             boolean,
  p_provider            text DEFAULT 'yookassa'
)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_current         timestamptz;
  v_trial_end       timestamptz;
  v_base            timestamptz;
  v_new             timestamptz;
  v_months          integer := COALESCE(p_period_months, 1);
  v_provider        text    := COALESCE(NULLIF(p_provider, ''), 'yookassa');
  v_existing_sub_id uuid;
BEGIN
  -- 1. Idempotent payment row (by provider, provider_payment_id).
  INSERT INTO public.payments (
    user_id, provider, provider_payment_id, amount, currency, status,
    plan, period_months, description, is_test, paid_at, raw_event, created_at
  ) VALUES (
    p_user_id, v_provider, p_provider_payment_id, p_amount, p_currency, 'succeeded',
    p_plan, v_months, 'BelFed subscription', p_is_test, p_paid_at, p_raw, now()
  )
  ON CONFLICT (provider, provider_payment_id) DO UPDATE
     SET status    = 'succeeded',
         paid_at   = EXCLUDED.paid_at,
         raw_event = EXCLUDED.raw_event;

  -- 2. Extend access from the later of current expiry / trial_end / now().
  SELECT subscription_expires_at, trial_end INTO v_current, v_trial_end
  FROM public.profiles WHERE id = p_user_id FOR UPDATE;

  v_base := GREATEST(COALESCE(v_current, now()), COALESCE(v_trial_end, now()), now());
  v_new  := v_base + make_interval(months => v_months);

  UPDATE public.profiles
     SET subscription_status     = 'active',
         subscription_expires_at = v_new,
         subscription_plan       = p_plan,
         updated_at              = now()
   WHERE id = p_user_id;

  -- 3. Provider-scoped subscriptions upsert (mirrors apply_stars_payment).
  SELECT id INTO v_existing_sub_id
  FROM public.subscriptions
  WHERE user_id = p_user_id
    AND status IN ('active','trialing','past_due')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF v_existing_sub_id IS NOT NULL THEN
    UPDATE public.subscriptions
       SET plan_code            = COALESCE(p_plan, plan_code),
           provider             = v_provider,
           status               = 'active',
           current_period_end   = v_new,
           cancel_at_period_end  = false,
           failed_attempts      = 0,
           last_charge_error    = NULL,
           last_charge_attempt_at = now(),
           updated_at           = now()
     WHERE id = v_existing_sub_id;
  ELSE
    INSERT INTO public.subscriptions (
      user_id, plan_code, provider, status, current_period_end,
      cancel_at_period_end, failed_attempts
    ) VALUES (
      p_user_id, p_plan, v_provider, 'active', v_new, false, 0
    );
  END IF;

  -- 4. ATTRIBUTION (new) — idempotent 'payment' conversion event. A replayed
  --    webhook re-enters here but record_payment_attribution DO-NOTHINGs on the
  --    '<provider>:<payment_id>' event_key, so revenue is never double-counted.
  BEGIN
    PERFORM public.record_payment_attribution(
      v_provider, p_provider_payment_id, p_user_id, p_amount, p_currency
    );
  EXCEPTION WHEN OTHERS THEN
    -- Attribution must never break a real payment. Swallow + log.
    RAISE WARNING 'record_payment_attribution failed: %', SQLERRM;
  END;

  RETURN v_new;
END;
$function$;

REVOKE ALL ON FUNCTION public.apply_successful_payment(text,uuid,numeric,text,text,integer,timestamptz,jsonb,boolean,text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.apply_successful_payment(text,uuid,numeric,text,text,integer,timestamptz,jsonb,boolean,text) TO service_role;

COMMIT;

-- -------------------------------------------------------------------------
-- Smoke tests (run separately, NOT in this transaction):
-- -------------------------------------------------------------------------
-- -- idempotency: second call returns NULL, table has exactly one row
-- select public.record_conversion_event('signup','trial-intent:tok_demo',
--   null,'anon-demo','akey-demo',
--   '{"utm_source":"threads","utm_medium":"social"}'::jsonb,'/ru/');
-- select public.record_conversion_event('signup','trial-intent:tok_demo',
--   null,'anon-demo','akey-demo','{}'::jsonb,'/ru/');  -- expect NULL
-- select count(*) from public.conversion_attribution where event_key='trial-intent:tok_demo'; -- expect 1
-- delete from public.conversion_attribution where event_key='trial-intent:tok_demo';
