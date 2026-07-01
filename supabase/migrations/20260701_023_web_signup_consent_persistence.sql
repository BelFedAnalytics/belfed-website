-- 20260701_023_web_signup_consent_persistence.sql
--
-- ROOT CAUSE
-- Web signup (supaClient.auth.signUp) creates auth.users -> handle_new_user
-- inserts the profile. The consent checkbox ticked on the web form was only
-- forwarded to trial-intent-create (stored inside the one-shot Telegram deep-
-- link token), so profiles.privacy_consent_at / terms_consent_at were written
-- ONLY later, if and when the user completed the Telegram claim flow
-- (claim_trial_by_telegram, migration 017). A web-only signup that never
-- claims via Telegram therefore left privacy_consent_at / terms_consent_at
-- NULL even though the user had accepted — exactly the QA finding.
--
-- FIX (minimal, reliable, page-agnostic)
-- The client now passes consent into signUp's options.data, which lands in
-- auth.users.raw_user_meta_data. This migration extends the existing
-- BEFORE INSERT trigger profiles_autostart_trial() (migration 022) to read
-- that metadata for NEW.id and stamp the profile's consent columns at profile-
-- creation time. Because it runs server-side in the same trigger that already
-- provisions the trial, consent is captured on EVERY signup surface regardless
-- of which page/JS initiated it, and it composes with the Telegram claim path
-- (claim_trial_by_telegram still COALESCEs and never overwrites a set value).
--
-- PRESERVED (unchanged): trial provisioning + coherence guard (022), the
-- canonical 14-day trial, trial_started_at sentinel semantics (only stamped
-- when telegram_id present, so claim_trial_by_telegram is not short-circuited),
-- user_has_access(), expire_trials(), staged reminders, winback, Founding logic.
--
-- NO BACKFILL OF LEGAL CONSENT
-- Legal consent timestamps are deliberately NOT backfilled for existing rows.
-- The only pre-existing evidence lives in unconsumed trial-intent tokens and is
-- not a reliable, per-row proof of what each historical user actually accepted;
-- fabricating consent timestamps would be legally worse than leaving them NULL.
-- Affected historical rows will acquire consent naturally on their next
-- consent-bearing action (Telegram claim / re-consent), or can be handled by a
-- separate, evidence-backed backfill if one is ever justified.

begin;

-- Consent columns were added out-of-band historically (referenced by migration
-- 017 but never in a versioned `add column`). Guard them idempotently so this
-- migration is self-contained.
alter table public.profiles
  add column if not exists privacy_consent_at timestamptz,
  add column if not exists terms_consent_at   timestamptz,
  add column if not exists consent_ip          text,
  add column if not exists consent_user_agent  text,
  add column if not exists consent_locale      text,
  add column if not exists trial_source        text;

create or replace function public.profiles_autostart_trial()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'auth'
as $function$
declare
  v_days int;
  v_now  timestamptz := now();
  v_end  timestamptz;
  v_meta jsonb;
  v_privacy_at timestamptz;
  v_terms_at   timestamptz;
begin
  v_days := coalesce((select value::int from public.config where key = 'trial_days'), 14);
  v_end  := v_now + make_interval(days => v_days);

  -- Only provision for pending/trial profiles — never touch active/admin/expired.
  if coalesce(new.subscription_status, 'trial') = 'trial'
     and new.trial_end is null
     and new.subscription_expires_at is null then
    new.subscription_plan       := coalesce(new.subscription_plan, 'trial');
    new.subscription_status     := 'trial';
    new.trial_start             := coalesce(new.trial_start, v_now);
    new.trial_end               := v_end;
    new.subscription_expires_at := v_end;
    -- trial_started_at is the "trial claimed" sentinel used by
    -- claim_trial_by_telegram(); set it only once Telegram is linked so the
    -- web -> link-Telegram flow is not short-circuited to 'trial_already_used'.
    if new.telegram_id is not null and new.telegram_id <> '' then
      new.trial_started_at := coalesce(new.trial_started_at, v_now);
    end if;
  end if;

  -- Coherence guard: a 'trial' row must never persist with a NULL trial_end.
  if new.subscription_status = 'trial' and new.trial_end is null then
    new.trial_start             := coalesce(new.trial_start, v_now);
    new.trial_end               := new.trial_start + make_interval(days => v_days);
    new.subscription_expires_at := coalesce(new.subscription_expires_at, new.trial_end);
    new.subscription_plan       := coalesce(new.subscription_plan, 'trial');
  end if;

  -- Consent capture: pull the consent the user accepted on the web form from
  -- auth.users.raw_user_meta_data (populated by signUp options.data). Visible
  -- within the same transaction as the auth.users INSERT that triggered
  -- handle_new_user. COALESCE guards ensure we never clobber a value that a
  -- caller (e.g. handle_new_user or claim flow) already set.
  select raw_user_meta_data into v_meta from auth.users where id = new.id;
  if v_meta is not null then
    -- Prefer explicit ISO timestamps from the client; otherwise stamp now()
    -- when the boolean accept flag is true. jsonb equality avoids ::boolean
    -- cast errors on unexpected values.
    v_privacy_at := coalesce(
      nullif(v_meta->>'privacy_consent_at', '')::timestamptz,
      case when (v_meta->'accept_privacy') = 'true'::jsonb then v_now end
    );
    v_terms_at := coalesce(
      nullif(v_meta->>'terms_consent_at', '')::timestamptz,
      case when (v_meta->'accept_terms') = 'true'::jsonb then v_now end
    );

    new.privacy_consent_at := coalesce(new.privacy_consent_at, v_privacy_at);
    new.terms_consent_at   := coalesce(new.terms_consent_at,   v_terms_at);
    new.consent_locale     := coalesce(new.consent_locale,     nullif(v_meta->>'consent_locale', ''));
    new.consent_user_agent := coalesce(new.consent_user_agent, nullif(v_meta->>'consent_user_agent', ''));
    if new.trial_source is null and (v_privacy_at is not null or v_terms_at is not null) then
      new.trial_source := coalesce(nullif(v_meta->>'source', ''), 'web_signup');
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.profiles_autostart_trial() is
  'BEFORE INSERT on profiles. Provisions a canonical 14-day trial for new pending/trial profiles (web signups included), keeping status/trial_end coherent, and stamps privacy/terms consent from auth.users.raw_user_meta_data (signUp options.data) so web-only signups persist consent without waiting for the Telegram claim. trial_started_at is stamped only when telegram_id is present, preserving the claim_trial_by_telegram sentinel.';

commit;
