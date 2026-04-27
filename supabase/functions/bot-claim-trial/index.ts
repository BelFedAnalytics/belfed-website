// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: bot-claim-trial
//
// Called by the Telegram bot (bot.py) on /start trial deep-link.
// Creates a "lite" profile (ghost-email tg_<id>@belfed.local) with a 14-day trial
// and returns a one-shot invite link to the paid Telegram channel.
//
// AUTH: shared secret in header `x-bot-secret` must match BOT_SHARED_SECRET env.
//
// REQUIRED SECRETS:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN              — for createChatInviteLink call
//   TRADING_CHANNEL_ID              — paid channel chat_id (e.g. -1003660492325)
//   BOT_SHARED_SECRET               — random string, also set on bot server
//   TRIAL_DAYS                      — optional, defaults to 14
//
// REQUEST (POST application/json):
//   { "telegram_id": "118296372", "telegram_username": "tyoma_fyodorov", "source": "telegram_direct" }
//
// RESPONSE 200:
//   { "ok": true, "user_id": "...", "trial_end": "...", "invite_link": "https://t.me/+...", "created": true }
//   { "ok": true, "already_active": true, "subscription_expires_at": "...", "invite_link": "https://t.me/+..." }
// RESPONSE 4xx:
//   { "ok": false, "error": "trial_already_used", "trial_end": "...", "subscription_status": "expired" }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN          = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TRADING_CHANNEL_ID = Deno.env.get("TRADING_CHANNEL_ID")!;
const BOT_SHARED_SECRET  = Deno.env.get("BOT_SHARED_SECRET")!;
const TRIAL_DAYS         = parseInt(Deno.env.get("TRIAL_DAYS") ?? "14", 10);

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bot-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

async function createInviteLink(chatId: string, expireSeconds = 24 * 3600): Promise<string | null> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/createChatInviteLink`;
  const expireDate = Math.floor(Date.now() / 1000) + expireSeconds;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      expire_date: expireDate,
      member_limit: 1,
      creates_join_request: false,
      name: `trial-${Date.now()}`,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    console.error("createChatInviteLink failed:", r.status, text);
    return null;
  }
  const j = await r.json();
  return j?.result?.invite_link ?? null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405, headers: cors });

  // Shared-secret check
  const incomingSecret = req.headers.get("x-bot-secret") ?? "";
  if (!BOT_SHARED_SECRET || incomingSecret !== BOT_SHARED_SECRET) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400);
  }

  const telegramIdRaw = body?.telegram_id;
  const telegramId = telegramIdRaw == null ? "" : String(telegramIdRaw).trim();
  const telegramUsername = body?.telegram_username ? String(body.telegram_username).trim() : null;
  const source = body?.source ? String(body.source).trim() : "telegram_direct";

  if (!telegramId || !/^\d+$/.test(telegramId)) {
    return json({ ok: false, error: "telegram_id_required" }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // 1. Claim trial via RPC
  const { data: claimRes, error: claimErr } = await admin.rpc("claim_trial_by_telegram", {
    p_telegram_id: telegramId,
    p_telegram_username: telegramUsername,
    p_trial_days: TRIAL_DAYS,
    p_source: source,
  });

  if (claimErr) {
    console.error("claim_trial RPC failed:", claimErr);
    return json({ ok: false, error: "db_error", detail: claimErr.message }, 500);
  }

  const result = claimRes as any;
  if (!result?.ok) {
    // Already-used trial — still return invite if subscription is currently active
    if (result?.error === "trial_already_used" && result?.subscription_status === "active") {
      const inviteLink = await createInviteLink(TRADING_CHANNEL_ID);
      return json({
        ok: true,
        user_id: result.user_id,
        already_active: true,
        invite_link: inviteLink,
      });
    }
    return json({
      ok: false,
      error: result?.error ?? "claim_failed",
      user_id: result?.user_id ?? null,
      trial_end: result?.trial_end ?? null,
      subscription_status: result?.subscription_status ?? null,
    }, 409);
  }

  // 2. Create one-shot invite link to paid channel
  const inviteLink = await createInviteLink(TRADING_CHANNEL_ID);
  if (!inviteLink) {
    // Trial granted but invite failed — return success without link, bot can retry
    return json({
      ok: true,
      user_id: result.user_id,
      trial_end: result.trial_end,
      created: result.created ?? false,
      already_active: result.already_active ?? false,
      invite_link: null,
      warning: "invite_link_creation_failed",
    });
  }

  // 3. Log the access grant
  try {
    await admin.from("telegram_access_log").insert({
      user_id: result.user_id,
      telegram_id: parseInt(telegramId, 10),
      chat_id: parseInt(TRADING_CHANNEL_ID, 10),
      action: "invite",
      result: "ok",
      detail: `trial granted via ${source}; invite=${inviteLink}`,
    });
  } catch (e) {
    console.warn("access log insert failed:", e);
  }

  return json({
    ok: true,
    user_id: result.user_id,
    trial_end: result.trial_end,
    created: result.created ?? false,
    already_active: result.already_active ?? false,
    invite_link: inviteLink,
  });
});
