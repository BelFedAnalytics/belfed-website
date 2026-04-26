-- ==========================================================================
-- PR #2 (commit 2): Single plan (1500 ₽/мес) + 14-day trial без карты
-- Идемпотентно. Можно запускать повторно.
-- ==========================================================================

-- ---- A) единый default plan -------------------------------------------------
update public.config
   set value = '1500.00'
 where key = 'price_month_rub';
update public.config
   set value = 'monthly'
 where key = 'default_plan';

-- если ключей не было — создаём
insert into public.config(key, value, description) values
  ('price_month_rub', '1500.00', 'Цена месячной подписки в рублях'),
  ('default_plan',    'monthly', 'Единственный план на сегодня'),
  ('trial_days',      '14',      'Длительность триала в днях')
on conflict (key) do nothing;

-- ---- B) trial helpers --------------------------------------------------------
alter table public.profiles
  add column if not exists trial_started_at timestamptz,
  add column if not exists trial_reminder_sent_at timestamptz;

-- ---- C) функция для запуска триала -----------------------------------------
-- Идемпотентна: если триал уже стартовал, ничего не делает.
create or replace function public.start_trial(p_user uuid)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_days   integer;
  v_until  timestamptz;
  v_existing timestamptz;
begin
  select coalesce((select value::int from public.config where key='trial_days'), 14) into v_days;

  select trial_started_at, subscription_expires_at into v_existing, v_until
    from public.profiles where id = p_user for update;

  if v_existing is not null then
    return v_until;
  end if;

  v_until := now() + make_interval(days => v_days);

  update public.profiles
     set trial_started_at = now(),
         subscription_plan = 'trial',
         subscription_expires_at = v_until
   where id = p_user;

  return v_until;
end;
$$;
grant execute on function public.start_trial(uuid) to service_role, authenticated;

-- ---- D) автоматический запуск триала при создании профиля -----------------
-- Если у вас уже есть on_auth_user_created → handle_new_user(), мы добавляем
-- отдельный триггер на profiles (UPDATE/INSERT), чтобы не зависеть от auth schema.

create or replace function public.profiles_autostart_trial()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.trial_started_at is null
     and new.subscription_expires_at is null then
    new.trial_started_at := now();
    new.subscription_plan := coalesce(new.subscription_plan, 'trial');
    new.subscription_expires_at := now() + make_interval(
      days => coalesce((select value::int from public.config where key='trial_days'), 14)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profiles_autostart_trial on public.profiles;
create trigger trg_profiles_autostart_trial
  before insert on public.profiles
  for each row execute function public.profiles_autostart_trial();

-- ---- E) view: пользователи, которым нужно отправить trial-reminder --------
create or replace view public.users_for_trial_reminder as
  select id as user_id,
         telegram_id,
         subscription_expires_at,
         trial_started_at
    from public.profiles
   where subscription_plan = 'trial'
     and trial_reminder_sent_at is null
     and telegram_id is not null
     and subscription_expires_at is not null
     and subscription_expires_at >  now() + interval '6 hours'
     and subscription_expires_at <= now() + interval '36 hours';

grant select on public.users_for_trial_reminder to service_role;

-- ---- F) обновление apply_successful_payment под единый план ----------------
-- (план всегда 'monthly', всегда +1 месяц — оставляем универсальный сигнатур,
--  на случай если в будущем добавим планы.) — без изменений сигнатуры.

-- END PR #2 commit 2
