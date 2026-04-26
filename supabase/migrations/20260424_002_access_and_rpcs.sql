-- ==========================================================================
-- PR #2: Access provisioning, recurring billing, cancellation (delta)
-- Run once in Supabase SQL Editor on project obujqvqqmyfcfflhqvud.
-- Idempotent: safe to re-run.
-- ==========================================================================

-- ----- A) subscriptions: columns we rely on in code but may be missing --------
alter table public.subscriptions
  add column if not exists plan_code    text,
  add column if not exists last_charge_attempt_at timestamptz,
  add column if not exists last_charge_error      text,
  add column if not exists failed_attempts        integer not null default 0;

create index if not exists idx_subscriptions_due
  on public.subscriptions(next_billing_at)
  where status = 'active' and cancel_at_period_end = false;

-- ----- B) payments: make sure columns used by functions exist ----------------
alter table public.payments
  add column if not exists provider            text default 'yookassa',
  add column if not exists provider_payment_id text,
  add column if not exists amount              numeric(12,2),
  add column if not exists currency            text default 'RUB',
  add column if not exists status              text,
  add column if not exists plan                text,
  add column if not exists period_months       integer,
  add column if not exists description         text,
  add column if not exists idempotence_key     text,
  add column if not exists is_test             boolean default false,
  add column if not exists paid_at             timestamptz,
  add column if not exists refunded_at         timestamptz;

create unique index if not exists ux_payments_provider_payment
  on public.payments(provider, provider_payment_id)
  where provider_payment_id is not null;

-- ----- C) payment_events (idempotency log for webhooks) ----------------------
create table if not exists public.payment_events (
  id                  uuid primary key default gen_random_uuid(),
  provider            text not null default 'yookassa',
  provider_event_id   text not null,
  event_type          text not null,
  provider_payment_id text,
  payload             jsonb,
  processed           boolean not null default false,
  processed_at        timestamptz,
  processing_error    text,
  created_at          timestamptz not null default now(),
  unique (provider, provider_event_id)
);

-- ----- D) telegram_access_log: audit invites / kicks -------------------------
create table if not exists public.telegram_access_log (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete set null,
  telegram_id bigint,
  chat_id     bigint not null,
  action      text not null check (action in ('invite','kick','unban','check')),
  result      text not null check (result in ('ok','error','noop')),
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists idx_tal_user on public.telegram_access_log(user_id);
create index if not exists idx_tal_tg   on public.telegram_access_log(telegram_id);

alter table public.telegram_access_log enable row level security;
drop policy if exists tal_read_own on public.telegram_access_log;
create policy tal_read_own on public.telegram_access_log
  for select using (auth.uid() = user_id);

-- ----- E) RPC: apply_successful_payment --------------------------------------
-- Called by yookassa-webhook on payment.succeeded. Writes the payment row,
-- extends profiles.subscription_expires_at by period_months (from whichever
-- of now() / current expiry is later), and returns the new expiry.

create or replace function public.apply_successful_payment(
  p_provider_payment_id text,
  p_user_id             uuid,
  p_amount              numeric,
  p_currency            text,
  p_plan                text,
  p_period_months       integer,
  p_paid_at             timestamptz,
  p_raw                 jsonb,
  p_is_test             boolean
) returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_current   timestamptz;
  v_base      timestamptz;
  v_new       timestamptz;
begin
  -- upsert payment row (idempotent by (provider, provider_payment_id))
  insert into public.payments (
    user_id, provider, provider_payment_id, amount, currency, status,
    plan, period_months, description, is_test, paid_at, raw_event, created_at
  ) values (
    p_user_id, 'yookassa', p_provider_payment_id, p_amount, p_currency, 'succeeded',
    p_plan, p_period_months, 'BelFed subscription', p_is_test, p_paid_at, p_raw, now()
  )
  on conflict (provider, provider_payment_id) do update
     set status   = 'succeeded',
         paid_at  = excluded.paid_at,
         raw_event = excluded.raw_event;

  -- current expiry (if any)
  select subscription_expires_at into v_current
  from public.profiles where id = p_user_id for update;

  v_base := greatest(coalesce(v_current, now()), now());
  v_new  := v_base + make_interval(months => coalesce(p_period_months, 1));

  update public.profiles
     set subscription_expires_at = v_new,
         subscription_plan       = p_plan
   where id = p_user_id;

  return v_new;
end;
$$;
grant execute on function public.apply_successful_payment(
  text, uuid, numeric, text, text, integer, timestamptz, jsonb, boolean
) to service_role;

-- ----- F) RPC: claim_telegram_link -------------------------------------------
-- Called by the Telegram bot when a user sends /link <token>.
-- Binds the Telegram user to the Supabase profile.
create or replace function public.claim_telegram_link(
  p_token       text,
  p_telegram_id bigint,
  p_username    text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_row   public.telegram_link_tokens;
  v_user  uuid;
begin
  select * into v_row from public.telegram_link_tokens
   where token = p_token for update;
  if not found then raise exception 'token_not_found'; end if;
  if v_row.used_at is not null then raise exception 'token_used'; end if;
  if v_row.expires_at < now() then raise exception 'token_expired'; end if;

  v_user := v_row.user_id;

  update public.telegram_link_tokens
     set used_at = now(), telegram_id = p_telegram_id
   where token = p_token;

  update public.profiles
     set telegram_id       = p_telegram_id,
         telegram_username = p_username
   where id = v_user;

  return v_user;
end;
$$;
grant execute on function public.claim_telegram_link(text, bigint, text) to service_role;

-- ----- G) View: subscriptions_due_for_charge ---------------------------------
create or replace view public.subscriptions_due_for_charge as
  select s.*
    from public.subscriptions s
   where s.status = 'active'
     and s.cancel_at_period_end = false
     and s.payment_method_id is not null
     and s.next_billing_at is not null
     and s.next_billing_at <= now() + interval '1 day'
     and coalesce(s.failed_attempts, 0) < 4;

grant select on public.subscriptions_due_for_charge to service_role;

-- ----- H) View: telegram_users_to_kick ---------------------------------------
-- Users who have a telegram_id but whose subscription_expires_at has passed by
-- more than 24 hours (grace window). Trial users are NOT kicked here; handled
-- separately based on profiles.subscription_expires_at which also stores trial.
create or replace view public.telegram_users_to_kick as
  select p.id as user_id,
         p.telegram_id,
         p.subscription_expires_at
    from public.profiles p
   where p.telegram_id is not null
     and p.subscription_expires_at is not null
     and p.subscription_expires_at < now() - interval '24 hours';

grant select on public.telegram_users_to_kick to service_role;

-- END PR #2
