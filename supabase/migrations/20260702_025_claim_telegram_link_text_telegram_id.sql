-- ============================================================================
-- 20260702_025  claim_telegram_link: cast p_telegram_id to text for profiles
-- ============================================================================
-- Follow-up to 20260702_024. That version compared and assigned
--   profiles.telegram_id = p_telegram_id
-- but the columns have DIFFERENT types in production:
--   * public.profiles.telegram_id            is TEXT
--   * public.telegram_link_tokens.telegram_id is BIGINT
-- so every touch of profiles.telegram_id raised
--   ERROR 42883: operator does not exist: text = bigint
-- at runtime, making the RPC unusable.
--
-- Fix: keep the bigint parameter (the bot sends a numeric Telegram id and the
-- token table column is bigint), but cast to text (p_telegram_id::text) for
-- every read/write against profiles.telegram_id. No column types change.
--
-- Semantics are otherwise identical to 024: structured jsonb {ok,error,...},
-- and the already-linked owner guard runs BEFORE any writes, so when the
-- Telegram id already belongs to a different profile (e.g. admin) we return
-- error='telegram_already_linked' WITHOUT marking the token used or updating
-- the token owner's profile.

drop function if exists public.claim_telegram_link(text, bigint, text);

create or replace function public.claim_telegram_link(
  p_token       text,
  p_telegram_id bigint,
  p_username    text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row   public.telegram_link_tokens;
  v_user  uuid;
  v_owner uuid;
  v_tg    text := p_telegram_id::text;   -- profiles.telegram_id is TEXT
begin
  select * into v_row from public.telegram_link_tokens
   where token = p_token for update;
  if not found                 then return jsonb_build_object('ok', false, 'error', 'token_not_found'); end if;
  if v_row.used_at is not null then return jsonb_build_object('ok', false, 'error', 'token_used'); end if;
  if v_row.expires_at < now()  then return jsonb_build_object('ok', false, 'error', 'token_expired'); end if;

  v_user := v_row.user_id;

  -- Is this Telegram id already bound to a different profile? If so, refuse —
  -- do not move the identity (protects admin and prevents silent hijacking).
  -- Runs BEFORE any write, so nothing is mutated on the already-linked path.
  select id into v_owner
    from public.profiles
   where telegram_id = v_tg
     and id <> v_user
   limit 1;
  if v_owner is not null then
    return jsonb_build_object(
      'ok', false,
      'error', 'telegram_already_linked',
      'linked_user_id', v_owner,
      'target_user_id', v_user
    );
  end if;

  update public.telegram_link_tokens
     set used_at = now(), telegram_id = p_telegram_id   -- bigint column
   where token = p_token;

  update public.profiles
     set telegram_id       = v_tg,                      -- text column
         telegram_username = p_username
   where id = v_user;

  return jsonb_build_object('ok', true, 'user_id', v_user);

-- Belt-and-braces: if a concurrent claim binds the same Telegram id between our
-- pre-check and the UPDATE, surface it as the same clear error instead of a 500.
exception when unique_violation then
  return jsonb_build_object('ok', false, 'error', 'telegram_already_linked');
end;
$$;

grant execute on function public.claim_telegram_link(text, bigint, text) to service_role;

comment on function public.claim_telegram_link(text, bigint, text) is
  'Web-first Telegram connect. Binds a Telegram identity to the token owner profile and marks the token used. Returns jsonb {ok,error,...}. profiles.telegram_id is text so the bigint arg is cast (p_telegram_id::text); telegram_link_tokens.telegram_id stays bigint. Refuses (telegram_already_linked) when the Telegram id already belongs to another profile — never moves the identity, so admin/other accounts are safe.';
