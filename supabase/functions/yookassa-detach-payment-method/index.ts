// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: yookassa-detach-payment-method
//
// Removes the saved card from the user's subscription.
// Per YooKassa recurring-payments policy: "При удалении карты вы должны
// удалить токен из своей системы. Сообщать нам об отвязке не требуется."
// (Source: https://yookassa.ru/developers/payment-acceptance/scenario-extensions/recurring-payments/basics)
//
// Behavior:
//   1. Clear payment_method_id, card_last4, card_brand.
//   2. Stamp payment_method_detached_at = now().
//   3. Set cancel_at_period_end = true so yookassa-charge-recurring stops
//      trying to renew (it filters by payment_method_id IS NOT NULL too).
//   4. Access remains valid until current_period_end — same UX as the
//      "cancel auto-renewal" button. The cron telegram-enforce-access kicks
//      the user from the paid Telegram channel after expiry.
//
// Auth: user JWT required (RLS-style). Service role is used internally to
// perform the update (subscriptions has restrictive RLS).
//
// Idempotent: safe to call multiple times. If no card is attached, returns
// { ok: true, already_detached: true }.
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  // 1) Authenticate the caller via their JWT.
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: u, error: userErr } = await userClient.auth.getUser();
  if (userErr || !u?.user) return json({ error: "unauthorized" }, 401);

  // 2) Find the user's subscription.
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: sub, error: subErr } = await admin
    .from("subscriptions")
    .select("id, status, current_period_end, payment_method_id, card_last4, card_brand")
    .eq("user_id", u.user.id)
    .maybeSingle();
  if (subErr) return json({ error: "db_error", detail: subErr.message }, 500);
  if (!sub)   return json({ error: "no_subscription" }, 404);

  // 3) If nothing to detach — return early, idempotent.
  if (!sub.payment_method_id) {
    return json({
      ok: true,
      already_detached: true,
      access_until: sub.current_period_end,
    });
  }

  const previousLast4 = sub.card_last4 ?? null;
  const previousBrand = sub.card_brand ?? null;

  // 4) Clear payment method + halt auto-renewal.
  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin
    .from("subscriptions")
    .update({
      payment_method_id:          null,
      card_last4:                 null,
      card_brand:                 null,
      payment_method_detached_at: nowIso,
      cancel_at_period_end:       true,
      cancel_reason:              "user_detached_card",
      updated_at:                 nowIso,
    })
    .eq("id", sub.id);
  if (updErr) return json({ error: "db_error", detail: updErr.message }, 500);

  // 5) Audit trail. Soft-failure: don't block the response if logging fails.
  try {
    await admin.from("payment_events").insert({
      provider: "yookassa",
      provider_event_id: `detach:${sub.id}:${Date.now()}`,
      event_type: "card.detached",
      provider_payment_id: null,
      payload: {
        user_id:        u.user.id,
        subscription_id: sub.id,
        card_last4:     previousLast4,
        card_brand:     previousBrand,
        detached_at:    nowIso,
        initiator:      "web_billing_page",
      },
      processed: true,
    });
  } catch (_) { /* ignore audit failures */ }

  return json({
    ok: true,
    access_until: sub.current_period_end,
    card_last4:   previousLast4,
    card_brand:   previousBrand,
    message: "Card detached. Auto-renewal stopped. Access remains until current_period_end.",
  });
});
