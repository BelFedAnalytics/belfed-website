-- Месячные отметки подписки: витрина для ежедневного уведомления админам
-- и журнал отправок, чтобы одна и та же отметка не пришла дважды.

create table if not exists public.member_tenure_notices (
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  months      integer not null,
  sent_at     timestamptz not null default now(),
  primary key (profile_id, months)
);

alter table public.member_tenure_notices enable row level security;
revoke all on public.member_tenure_notices from anon, authenticated;
grant all on public.member_tenure_notices to service_role;

-- Стаж считаем от первого платежа. Отметка «прошёл ещё месяц» наступает в тот
-- же день месяца; если в текущем месяце такого числа нет (31 мая -> июнь),
-- отметка приходит в последний день месяца.
create or replace view public.member_tenure_status as
with paid as (
  select
    p.id                     as profile_id,
    p.lang,
    p.email,
    p.telegram_id,
    p.telegram_username,
    p.founding_member,
    p.subscription_plan,
    p.subscription_status,
    p.subscription_expires_at,
    min(pay.created_at)::date as first_paid,
    count(pay.id)             as payments_count
  from public.profiles p
  join public.payments pay on pay.user_id = p.id
  where p.subscription_status = 'active'
  group by 1,2,3,4,5,6,7,8,9
)
select
  paid.*,
  (current_date - first_paid)                                        as tenure_days,
  greatest(0, (extract(year  from age(current_date, first_paid))::int * 12)
            + extract(month from age(current_date, first_paid))::int) as months_elapsed,
  (
    extract(day from first_paid)::int = extract(day from current_date)::int
    or (
      extract(day from first_paid)::int > extract(day from (date_trunc('month', current_date)
            + interval '1 month' - interval '1 day'))::int
      and current_date = (date_trunc('month', current_date)
            + interval '1 month' - interval '1 day')::date
    )
  )                                                                  as anniversary_today
from paid;

revoke all on public.member_tenure_status from anon, authenticated;
grant select on public.member_tenure_status to service_role;
