-- research_email_optins: double opt-in requests from the public /research/ subscribe form.
-- A row is created on submit; the email_subscribers row is created/reactivated only
-- after the owner of the address clicks the confirmation link. Service role only.
create table if not exists public.research_email_optins (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  lang text not null check (lang in ('ru','en')),
  token_hash text not null unique,
  consent_text text not null,
  consent_version text not null,
  page text,
  ip_hash text,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '72 hours'),
  email_sent_at timestamptz,
  confirmed_at timestamptz,
  subscriber_id uuid references public.email_subscribers(id) on delete set null
);
create index if not exists research_email_optins_email_idx on public.research_email_optins (lower(email), created_at desc);
create index if not exists research_email_optins_ip_idx on public.research_email_optins (ip_hash, created_at desc);
alter table public.research_email_optins enable row level security;
revoke all on public.research_email_optins from anon, authenticated;
comment on table public.research_email_optins is 'Double opt-in requests from /research/ free email subscription (research-subscribe edge function). Stores consent text/version as proof.';
