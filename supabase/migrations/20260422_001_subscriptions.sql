-- ==========================================================================
-- PR #1: YooKassa subscriptions + Telegram linking (delta, FIXED)
-- ==========================================================================
-- Idempotent delta applied to the existing schema of Supabase project
-- obujqvqqmyfcfflhqvud (belfed.com / belfed.ru).
--
-- STATUS: already applied on production via Supabase Dashboard -> SQL Editor.
-- This file versions the schema change in git. Re-running is safe.
--
-- Pre-existing tables touched here: profiles, subscriptions, payments.
-- New tables created here: telegram_link_tokens, config.
-- ==========================================================================

-- 1) PROFILES
alter table public.profiles
  add column if not exists telegram_id             bigint,
  add column if not exists telegram_username       text,
  add column if not exists subscription_plan       text,
  add column if not exists subscription_expires_at timestamptz,
  add column if not exists yookassa_customer_id    text;

create unique index if not exists idx_profiles_telegram_id
  on public.profiles(telegram_id) where telegram_id is not null;

-- 2) SUBSCRIPTIONS (existing: id, user_id, status, cancel_at_period_end,
--    current_period_start, current_period_end, cancel_at, canceled_at,
--    created_at, ended_at, trial_start, trial_end, plan, price_id,
--    quantity, metadata)
alter table public.subscriptions
  add column if not exists provider                text default 'yookassa',
  add column if not exists provider_subscription_id text,
  add column if not exists provider_customer_id    text,
  add column if not exists payment_method_id       text,
  add column if not exists next_billing_at         timestamptz,
  add column if not exists amount_rub              integer default 1500,
  add column if not exists cancel_reason           text,
  add column if not exists updated_at              timestamptz not null default now();

create index if not exists idx_subscriptions_user_status
  on public.subscriptions(user_id, status);
create index if not exists idx_subscriptions_next_billing
  on public.subscriptions(next_billing_at) where status = 'active';

-- 3) PAYMENTS
alter table public.payments
  add column if not exists is_recurring  boolean not null default false,
  add column if not exists receipt_email text,
  add column if not exists raw_event     jsonb,
  add column if not exists canceled_at   timestamptz,
  add column if not exists created_at    timestamptz not null default now();

create index if not exists idx_payments_user_created
  on public.payments(user_id, created_at desc);
create index if not exists idx_payments_provider_status
  on public.payments(provider, status);

-- 4) TELEGRAM_LINK_TOKENS
create table if not exists public.telegram_link_tokens (
  token       text primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  telegram_id bigint,
  direction   text not null default 'site_to_bot'
              check (direction in ('site_to_bot','bot_to_site')),
  expires_at  timestamptz not null default (now() + interval '15 minutes'),
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_tlt_user     on public.telegram_link_tokens(user_id);
create index if not exists idx_tlt_telegram on public.telegram_link_tokens(telegram_id);
create index if not exists idx_tlt_expires  on public.telegram_link_tokens(expires_at) where used_at is null;

-- 5) CONFIG
create table if not exists public.config (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);

insert into public.config (key, value) values
  ('telegram_channel_id', '-1003773738299'),
  ('seller_inn',          '781103296545'),
  ('seller_ogrnip',       '326784700016572'),
  ('seller_name',         'ИП Федоров Артем Игоревич'),
  ('seller_email',        'contact@belfed.com'),
  ('vat_code',            '6'),
  ('plan_pro_amount_rub', '1500'),
  ('plan_pro_period_days','30')
on conflict (key) do nothing;

-- 6) Helper: uses current_period_end (real column name)
create or replace function public.is_user_subscribed(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.subscriptions
    where user_id = uid
      and status in ('active','trialing')
      and (current_period_end is null or current_period_end > now())
  );
$$;
grant execute on function public.is_user_subscribed(uuid) to authenticated, anon;

-- 7) RLS
alter table public.subscriptions        enable row level security;
alter table public.payments             enable row level security;
alter table public.telegram_link_tokens enable row level security;
alter table public.config               enable row level security;

drop policy if exists subs_read_own on public.subscriptions;
create policy subs_read_own on public.subscriptions
  for select using (auth.uid() = user_id);

drop policy if exists pay_read_own on public.payments;
create policy pay_read_own on public.payments
  for select using (auth.uid() = user_id);

drop policy if exists tlt_read_own on public.telegram_link_tokens;
create policy tlt_read_own on public.telegram_link_tokens
  for select using (auth.uid() = user_id);

drop policy if exists tlt_insert_own on public.telegram_link_tokens;
create policy tlt_insert_own on public.telegram_link_tokens
  for insert with check (auth.uid() = user_id and direction = 'site_to_bot');

drop policy if exists config_read_public on public.config;
create policy config_read_public on public.config
  for select using (key in ('telegram_channel_id','seller_name'));

-- END PR #1
