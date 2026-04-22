-- PR #1 (plan): subscriptions + payments + telegram link tokens/accounts + RLS
-- Target: Supabase project obujqvqqmyfcfflhqvud (belfed.com / belfed.ru)
-- Apply manually via Supabase Dashboard -> SQL Editor until supabase CLI is wired up.

set search_path = public;

-- 1) subscriptions ---------------------------------------------------------
create table if not exists public.subscriptions (
  id                          uuid primary key default gen_random_uuid(),
  user_id                     uuid not null references auth.users(id) on delete cascade,
  plan                        text not null check (plan in ('month')),
  status                      text not null check (status in ('active','past_due','grace','canceled','pending')),
  current_period_start        timestamptz,
  current_period_end          timestamptz,
  cancel_at_period_end        boolean not null default false,
  canceled_at                 timestamptz,
  yookassa_payment_method_id  text,
  last_payment_id             uuid,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now(),
  unique (user_id, plan)
);

create index if not exists subscriptions_user_status_idx
  on public.subscriptions (user_id, status);
create index if not exists subscriptions_period_end_idx
  on public.subscriptions (current_period_end)
  where status in ('active','grace');

-- 2) payments --------------------------------------------------------------
create table if not exists public.payments (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references auth.users(id) on delete cascade,
  subscription_id       uuid references public.subscriptions(id) on delete set null,
  yookassa_payment_id   text not null unique,
  amount_rub            numeric(12,2) not null,
  currency              text not null default 'RUB',
  status                text not null check (status in ('pending','waiting_for_capture','succeeded','canceled','refunded')),
  is_recurring          boolean not null default false,
  receipt_id            text,
  receipt_status        text,
  raw                   jsonb,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);
create index if not exists payments_subscription_idx
  on public.payments (subscription_id);

-- 3) telegram_accounts (long-lived link between auth.user and TG user) -----
create table if not exists public.telegram_accounts (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  tg_user_id    bigint not null unique,
  tg_username   text,
  tg_chat_id    bigint,
  linked_at     timestamptz not null default now(),
  unlinked_at   timestamptz
);

-- 4) telegram_link_tokens (one-time tokens for /start link_xxx) ------------
create table if not exists public.telegram_link_tokens (
  token       uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  expires_at  timestamptz not null default (now() + interval '30 minutes'),
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists tg_link_tokens_user_idx
  on public.telegram_link_tokens (user_id);
create index if not exists tg_link_tokens_expires_idx
  on public.telegram_link_tokens (expires_at)
  where used_at is null;

-- 5) updated_at trigger ----------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_subscriptions_updated_at on public.subscriptions;
create trigger trg_subscriptions_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

drop trigger if exists trg_payments_updated_at on public.payments;
create trigger trg_payments_updated_at
  before update on public.payments
  for each row execute function public.set_updated_at();

-- 6) RLS -------------------------------------------------------------------
alter table public.subscriptions         enable row level security;
alter table public.payments              enable row level security;
alter table public.telegram_accounts     enable row level security;
alter table public.telegram_link_tokens  enable row level security;

-- subscriptions: user reads own row; writes only via service_role (Edge Functions).
drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- payments: user reads own rows; writes only via service_role.
drop policy if exists "payments_select_own" on public.payments;
create policy "payments_select_own"
  on public.payments for select
  using (auth.uid() = user_id);

-- telegram_accounts: user reads own row; writes only via service_role.
drop policy if exists "tg_accounts_select_own" on public.telegram_accounts;
create policy "tg_accounts_select_own"
  on public.telegram_accounts for select
  using (auth.uid() = user_id);

-- telegram_link_tokens: NO anon/authenticated access. service_role bypasses RLS.
-- (Intentionally no policies -> effectively locked for clients.)

-- 7) Grants ----------------------------------------------------------------
-- Keep default grants; Edge Functions use service_role which bypasses RLS.
