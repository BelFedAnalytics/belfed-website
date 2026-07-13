-- 20260713_026_attribution_conversion.sql
-- =========================================================================
-- Threads / paid-acquisition conversion attribution — source of truth.
--
-- End-to-end funnel: landing UTM → anonymous session → signup (trial-intent)
-- → trial claim (Telegram) → payment. Each stage writes ONE idempotent row to
-- public.conversion_funnel_events keyed by a stable event_key, so replays
-- (double webhook, retried bot claim, resent form) never duplicate a
-- conversion.
--
-- !!! TABLE NAMING — READ THIS !!!
-- We deliberately DO NOT reuse the pre-existing public.conversion_attribution
-- table. That table already exists in production with a DIFFERENT purpose
-- (Threads *content* attribution: queue_id / experiment_id / thread_id /
-- published_url, with attribution_model + metadata + occurred_at all NOT NULL
-- and NO event_key column). Overloading it would (a) fail our NOT-NULL-free
-- inserts, (b) require an ALTER that mutates a live analytics table, and (c)
-- pollute existing content dashboards with funnel rows. This migration creates
-- a separate, purpose-built table instead. conversion_attribution is left
-- untouched.
--
-- PII rule: conversion_funnel_events stores ONLY pseudonymous anonymous_id +
-- allowlisted UTM/referrer/landing_page. Email / telegram_id / names never
-- land here. The browser (belfed-attribution.js) and the edge functions
-- (_shared/attribution.ts) both sanitize; this migration is the last line of
-- defense at the DB boundary.
--
-- Idempotent: safe to re-run. Uses CREATE ... IF NOT EXISTS / ADD COLUMN IF
-- NOT EXISTS throughout so it applies cleanly against the live DB where
-- trial_intents already exists (it is not created by any repo migration).
--
-- !!! apply_successful_payment (Section E) !!!
-- Section E is a VERBATIM copy of the deployed provider-aware body
-- (select pg_get_functiondef('public.apply_successful_payment'::regproc)),
-- with exactly ONE addition: a guarded PERFORM public.record_payment_attribution
-- immediately before RETURN v_new. Every line of live logic — the admin
-- no-downgrade guard, the YooKassa saved-card capture, the provider-scoped
-- subscriptions upsert — is preserved. The 10-arg signature (p_provider DEFAULT
-- 'yookassa') and the timestamptz return are unchanged, so both callers
-- (yookassa-webhook: 9 args; tribute-webhook: 10 args incl. p_provider) keep
-- working. record_payment_attribution (Section D) is standalone and safe on its
-- own. Re-diff Section E against live at deploy time; if live has drifted since
-- capture, port ONLY the marked ATTRIBUTION block into the current body.
-- =========================================================================

BEGIN;

-- -------------------------------------------------------------------------
-- A) conversion_funnel_events — one idempotent row per funnel event
-- -------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.conversion_funnel_events (
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

-- Defensive ADD COLUMNs — no-ops when the column already exists (safe re-run).
ALTER TABLE public.conversion_funnel_events
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
CREATE UNIQUE INDEX IF NOT EXISTS ux_conversion_funnel_events_event_key
  ON public.conversion_funnel_events(event_key)
  WHERE event_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversion_funnel_events_profile
  ON public.conversion_funnel_events(profile_id);
CREATE INDEX IF NOT EXISTS idx_conversion_funnel_events_anon
  ON public.conversion_funnel_events(anonymous_id);

-- RLS: internal analytics table. service_role bypasses RLS; nobody else reads.
ALTER TABLE public.conversion_funnel_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.conversion_funnel_events FROM anon, authenticated;
-- (no policies → anon/authenticated get no access; edge fns use service_role)

-- -------------------------------------------------------------------------
-- B) trial_intents — attach attribution to the signup intent
-- -------------------------------------------------------------------------
-- trial_intents already exists in the live DB (token, email, lang, source,
-- intent_type, consent_*, privacy/terms_consent_at, expires_at, consumed_*,
-- profile_id). CREATE IF NOT EXISTS is a safety net for fresh environments;
-- the ADD COLUMN IF NOT EXISTS lines are the real, additive work.
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

  INSERT INTO public.conversion_funnel_events (
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

  -- attribution_key is set to the opaque trial token so the later 'trial' event
  -- (written by the bot with the same token) shares one attribution handle.
  RETURN public.record_conversion_event(
    p_event_type      => 'signup',
    p_event_key       => 'trial-intent:' || p_token,
    p_profile_id      => p_profile_id,
    p_anonymous_id    => p_anonymous_id,
    p_attribution_key => COALESCE(NULLIF(p_attribution_key, ''), p_token),
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
-- inheriting UTM from the touch captured at signup time. p_token is the opaque
-- trial token the bot forwards (bot PR #5 sends it as both intent_token and
-- attribution_key).
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
    p_attribution_key => COALESCE(NULLIF(v_intent.attribution_key, ''), p_token),
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
  v_prior public.conversion_funnel_events%ROWTYPE;
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
  FROM public.conversion_funnel_events
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
-- E) apply_successful_payment — VERBATIM live body + attribution call
-- -------------------------------------------------------------------------
-- Body below is copied verbatim from the deployed function
-- (pg_get_functiondef('public.apply_successful_payment'::regproc)). The ONLY
-- change vs. live is the marked ATTRIBUTION block added right before RETURN.
-- Re-diff against live at deploy time; if live has drifted, port ONLY the
-- ATTRIBUTION block rather than applying this wholesale.
CREATE OR REPLACE FUNCTION public.apply_successful_payment(
  p_provider_payment_id text,
  p_user_id             uuid,
  p_amount              numeric,
  p_currency            text,
  p_plan                text,
  p_period_months       integer,
  p_paid_at             timestamp with time zone,
  p_raw                 jsonb,
  p_is_test             boolean,
  p_provider            text DEFAULT 'yookassa'::text
)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_current         timestamptz;
  v_trial_end       timestamptz;
  v_base            timestamptz;
  v_new             timestamptz;
  v_method_id       text;
  v_method_saved    boolean;
  v_existing_sub_id uuid;
  v_is_admin        boolean;
  v_provider        text := coalesce(nullif(trim(p_provider), ''), 'yookassa');
begin
  -- 1) Persist payment (works for any provider, keyed by (provider, provider_payment_id))
  insert into public.payments (
    user_id, provider, provider_payment_id, amount, currency, status,
    plan, period_months, description, is_test, paid_at, raw_event, created_at
  ) values (
    p_user_id, v_provider, p_provider_payment_id, p_amount, p_currency, 'succeeded',
    p_plan, p_period_months, 'BelFed subscription', p_is_test, p_paid_at, p_raw, now()
  )
  on conflict (provider, provider_payment_id) do update
     set status    = 'succeeded',
         paid_at   = excluded.paid_at,
         raw_event = excluded.raw_event;

  -- 2) Compute new access expiry from current profile state
  select subscription_expires_at, trial_end, (subscription_status = 'admin')
    into v_current, v_trial_end, v_is_admin
  from public.profiles where id = p_user_id for update;

  v_base := greatest(coalesce(v_current, now()), coalesce(v_trial_end, now()), now());
  v_new  := v_base + make_interval(months => coalesce(p_period_months, 1));

  -- 3) YooKassa embeds saved card in payload; Tribute does not (its 'method' is the Telegram user)
  if v_provider = 'yookassa' then
    v_method_id    := p_raw->'object'->'payment_method'->>'id';
    v_method_saved := coalesce((p_raw->'object'->'payment_method'->>'saved')::boolean, false);
  else
    v_method_id    := null;
    v_method_saved := false;
  end if;

  -- 4) Extend paid access on profile (admin users are never downgraded/overwritten)
  update public.profiles
     set subscription_status     = case when v_is_admin then subscription_status else 'active' end,
         subscription_expires_at = case when v_is_admin then subscription_expires_at else v_new end,
         subscription_plan       = case when v_is_admin then subscription_plan       else p_plan end,
         updated_at              = now()
   where id = p_user_id;

  -- 5) Upsert subscription row for the SAME provider only.
  --    This prevents Tribute payments from overwriting a YooKassa row (and vice versa).
  select id into v_existing_sub_id
  from public.subscriptions
  where user_id = p_user_id
    and provider = v_provider
    and status in ('active','trialing','past_due')
  order by created_at desc
  limit 1
  for update;

  if v_existing_sub_id is not null then
    update public.subscriptions
       set plan_code = p_plan,
           status = 'active',
           current_period_end = v_new,
           cancel_at_period_end = false,
           payment_method_id = case
                                 when v_method_saved and v_method_id is not null then v_method_id
                                 else payment_method_id
                               end,
           next_billing_at = v_new,
           amount_rub = case when upper(p_currency) = 'RUB' then p_amount::int else amount_rub end,
           failed_attempts = 0,
           last_charge_error = null,
           last_charge_attempt_at = now(),
           cancel_reason = null,
           updated_at = now()
     where id = v_existing_sub_id;
  else
    insert into public.subscriptions (
      user_id, plan_code, provider, provider_subscription_id,
      status, current_period_end, cancel_at_period_end,
      payment_method_id, next_billing_at, amount_rub, failed_attempts,
      currency
    ) values (
      p_user_id, p_plan, v_provider, p_provider_payment_id,
      'active', v_new, false,
      case when v_method_saved then v_method_id else null end,
      v_new,
      case when upper(p_currency) = 'RUB' then p_amount::int else null end,
      0,
      lower(p_currency)
    );
  end if;

  -- ATTRIBUTION (added vs. live) — idempotent 'payment' conversion event.
  -- A replayed webhook re-enters here, but record_payment_attribution
  -- DO-NOTHINGs on the '<provider>:<payment_id>' event_key, so revenue is
  -- never double-counted. Wrapped so attribution can never fail a real payment.
  begin
    perform public.record_payment_attribution(
      v_provider, p_provider_payment_id, p_user_id, p_amount, p_currency
    );
  exception when others then
    raise warning 'record_payment_attribution failed: %', sqlerrm;
  end;

  return v_new;
end;
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
-- select count(*) from public.conversion_funnel_events where event_key='trial-intent:tok_demo'; -- expect 1
-- delete from public.conversion_funnel_events where event_key='trial-intent:tok_demo';
