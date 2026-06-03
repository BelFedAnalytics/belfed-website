-- Архитектурный fix: в функции merge_lite_into_full не было reparent
-- для 8 child-таблиц (subscriptions, payments, subscription_events,
-- feedback_messages, chart_requests, email_subscribers, link_tokens, trial_intents).
-- Это приводило к тому, что после merge в админке юзер был виден под старым
-- lite-email (tg_XXX@belfed.local) вместо настоящего. Данные уже починены
-- миграцией _008, эта фиксит функцию чтобы проблема не повторялась.
--
-- Сохраняем все существующее поведение (telegram_links upsert, telegram_access_log),
-- только добавляем reparent дочерних таблиц перед выставлением merged_into_user_id.

CREATE OR REPLACE FUNCTION public.merge_lite_into_full(p_full_user_id uuid, p_lite_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $function$
DECLARE
  v_lite   public.profiles%ROWTYPE;
  v_full   public.profiles%ROWTYPE;
  v_tg_id  text;
  v_tg_u   text;
  v_moved  jsonb := '{}'::jsonb;
  v_rows   int;
BEGIN
  IF p_full_user_id = p_lite_user_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'same_user');
  END IF;

  SELECT * INTO v_lite FROM public.profiles WHERE id = p_lite_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'lite_not_found'); END IF;

  SELECT * INTO v_full FROM public.profiles WHERE id = p_full_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'full_not_found'); END IF;

  v_tg_id := COALESCE(v_lite.telegram_id, NULLIF(REPLACE(v_full.telegram_id, '@', ''), ''));
  v_tg_u  := COALESCE(v_lite.telegram_username, v_full.telegram_username);

  -- Сначала развязываем lite (освобождаем уникальные индексы)
  UPDATE public.profiles
     SET telegram_id          = NULL,
         telegram_username    = NULL,
         updated_at           = now()
   WHERE id = p_lite_user_id;

  UPDATE public.profiles
     SET telegram_id        = v_tg_id,
         telegram_username  = v_tg_u,
         updated_at         = now()
   WHERE id = p_full_user_id;

  -- Перепривязываем все child-таблицы lite → full
  UPDATE public.subscriptions SET user_id = p_full_user_id, updated_at = now() WHERE user_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('subscriptions', v_rows);

  UPDATE public.payments SET user_id = p_full_user_id WHERE user_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('payments', v_rows);

  UPDATE public.subscription_events SET user_id = p_full_user_id WHERE user_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('subscription_events', v_rows);

  UPDATE public.feedback_messages SET profile_id = p_full_user_id WHERE profile_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('feedback_messages', v_rows);

  UPDATE public.chart_requests SET user_id = p_full_user_id WHERE user_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('chart_requests', v_rows);

  UPDATE public.email_subscribers SET profile_id = p_full_user_id WHERE profile_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('email_subscribers', v_rows);

  UPDATE public.link_tokens SET user_id = p_full_user_id WHERE user_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('link_tokens', v_rows);

  UPDATE public.trial_intents SET profile_id = p_full_user_id WHERE profile_id = p_lite_user_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT; v_moved := v_moved || jsonb_build_object('trial_intents', v_rows);

  -- Отмечаем сам stub как merged ПОСЛЕ reparent (чтобы RLS-проверки на этом стабе не ломали логику)
  UPDATE public.profiles
     SET merged_into_user_id = p_full_user_id,
         updated_at = now()
   WHERE id = p_lite_user_id;

  IF v_tg_id IS NOT NULL AND v_tg_id ~ '^\d+$' THEN
    INSERT INTO public.telegram_links (user_id, telegram_user_id, telegram_username, linked_at, is_active)
    VALUES (p_full_user_id, v_tg_id::bigint, v_tg_u, now(), true)
    ON CONFLICT (telegram_user_id) WHERE is_active = true DO UPDATE
      SET user_id            = EXCLUDED.user_id,
          telegram_username  = EXCLUDED.telegram_username,
          linked_at          = now();
  END IF;

  UPDATE public.telegram_access_log SET user_id = p_full_user_id WHERE user_id = p_lite_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'merged_lite_id', p_lite_user_id,
    'into', p_full_user_id,
    'telegram_id', v_tg_id,
    'telegram_username', v_tg_u,
    'moved', v_moved
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.merge_lite_into_full(uuid, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.merge_lite_into_full(uuid, uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.merge_lite_into_full(uuid, uuid) FROM authenticated;
