-- 018: Card metadata + detach support
--
-- 1) Store last4/brand so the user sees "Visa •••• 4242" in /billing.
-- 2) Track when the card was attached and when it was detached.
-- 3) Idempotent: safe to re-run.
-- 4) No data is removed for existing subscriptions; new columns are NULL until
--    the next successful YooKassa payment with save_payment_method=true fills
--    them in via the webhook.

alter table public.subscriptions
  add column if not exists card_last4               text,
  add column if not exists card_brand               text,
  add column if not exists payment_method_saved_at  timestamptz,
  add column if not exists payment_method_detached_at timestamptz;

comment on column public.subscriptions.card_last4 is
  'Last 4 digits of the saved card (from YooKassa payment_method.card.last4). NULL means no card attached.';
comment on column public.subscriptions.card_brand is
  'Card brand: visa / mastercard / mir / unionpay / etc. From YooKassa payment_method.card.card_type.';
comment on column public.subscriptions.payment_method_saved_at is
  'When the user attached this card (first successful save_payment_method=true charge).';
comment on column public.subscriptions.payment_method_detached_at is
  'When the user removed the card via /billing. NULL if currently attached.';

-- Helpful index for the billing UI: quickly find active payment methods.
create index if not exists idx_subscriptions_payment_method
  on public.subscriptions(user_id)
  where payment_method_id is not null;
