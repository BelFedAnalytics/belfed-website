-- ============================================================================
-- 20260702_024  claim_telegram_link: structured result + safe already-linked
-- ============================================================================
-- Web-first Telegram connect: the site issues a single-use token via the
-- telegram-link-start Edge Function; the bot sends /start <token> and calls
-- this RPC to bind the Telegram identity to the token's OWNER profile.
--
-- Two problems with the previous version (20260424_002):
--   1. It returned a bare uuid and RAISEd on every error, so the bot could only
--      tell "worked" from "didn't" via HTTP status — no way to give clear UX.
--   2. profiles.telegram_id has a UNIQUE index. When the Telegram account is
--      already linked to a DIFFERENT profile (e.g. the admin account), the
--      UPDATE hit that unique index and raised unique_violation. That both
--      produced a useless error AND risked being "fixed" later by code that
--      moves the identity off the existing profile — which would break admin.
--
-- This version returns jsonb {ok, error, ...} and, when the Telegram id already
-- belongs to another profile, returns error='telegram_already_linked' WITHOUT
-- touching either profile. A Telegram account maps to exactly one BelFed
-- profile; relinking must be an explicit, deliberate action, never a silent
-- side effect of clicking a web link.

drop function if exists public.claim_telegram_link(text, bigint, text);

create or replace function public.claim_telegram_link(
  p_token       text,
  p_telegram_id bigint,
  p_username    text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_row    public.telegram_link_tokens;
  v_user   uuid;
  v_owner  uuid;
begin
  select * into v_row from public.telegram_link_tokens
   where token = p_token for update;
  if not found                       then return jsonb_build_object('ok', false, 'error', 'token_not_found'); end if;
  if v_row.used_at is not null       then return jsonb_build_object('ok', false, 'error', 'token_used'); end if;
  if v_row.expires_at < now()        then return jsonb_build_object('ok', false, 'error', 'token_expired'); end if;

  v_user := v_row.user_id;

  -- Is this Telegram id already bound to a different profile? If so, refuse —
  -- do not move the identity (protects admin and prevents silent hijacking).
  select id into v_owner
    from public.profiles
   where telegram_id = p_telegram_id
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
     set used_at = now(), telegram_id = p_telegram_id
   where token = p_token;

  update public.profiles
     set telegram_id       = p_telegram_id,
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
  'Web-first Telegram connect. Binds a Telegram identity to the token owner profile and marks the token used. Returns jsonb {ok,error,...}. Refuses (telegram_already_linked) when the Telegram id already belongs to another profile — never moves the identity, so admin/other accounts are safe.';
