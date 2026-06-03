// deno-lint-ignore-file no-explicit-any
//
// yookassa-create-payment
// ========================
// Creates a YooKassa payment URL for a user.
//
// Pricing is RESOLVED on the server via RPC `resolve_payment_price(user_id)`:
//   - standard:           1500 RUB (from pricing_config)
//   - founding pending:   1050 RUB (founding_intent=true, claim_founding_slot will run on webhook)
//   - already founding:   1050 RUB (founding_intent=false, already has the slot)
//
// PROVIDER GATING (hard split):
//   - founding RU → must use YooKassa  (this function)
//   - founding EN → must use Telegram Stars (handled in bot.py)
//   - If a user with EN founding intent reaches this function, we 409 with a
//     pointer to use Stars. This prevents arbitrage and keeps tax/locale clean.
//
// Auth paths (unchanged):
//   1. Bot call: x-bot-secret header → body.user_id (uuid) required
//   2. User call: Authorization: Bearer <jwt>
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL       = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY           = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODE               = Deno.env.get("YOOKASSA_MODE") ?? "test";
const SHOP_ID            = MODE === "live"
  ? Deno.env.get("YOOKASSA_SHOP_ID")!
  : Deno.env.get("YOOKASSA_TEST_SHOP_ID")!;
const SECRET_KEY         = MODE === "live"
  ? Deno.env.get("YOOKASSA_SECRET_KEY")!
  : Deno.env.get("YOOKASSA_TEST_SECRET_KEY")!;
const SAVE_PM            = (Deno.env.get("SAVE_PAYMENT_METHOD") ?? "false").toLowerCase() === "true";
const BOT_SHARED_SECRET  = Deno.env.get("BOT_SHARED_SECRET") ?? "";

const RETURN_URL = "https://belfed.ru/members.html?payment=return";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bot-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const isGhostEmail = (e: string | null | undefined) =>
  !!e && /@belfed\.local$/i.test(e);

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const body = await req.json().catch(() => ({}));
  const planKey: string = (body.plan ?? "month").toString();
  if (!["month", "monthly", "1m"].includes(planKey)) {
    return jsonResp({ error: `unknown_plan: ${planKey}` }, 400);
  }

  // ---------- Auth ---------------------------------------------------------
  let userId: string | null = null;
  let userEmail: string | null = null;
  let isLite = false;

  const incomingBotSecret = req.headers.get("x-bot-secret") ?? "";
  if (BOT_SHARED_SECRET && incomingBotSecret === BOT_SHARED_SECRET) {
    const requestedUserId = (body.user_id ?? "").toString().trim();
    if (!requestedUserId) return jsonResp({ error: "user_id_required" }, 400);
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("id, email, is_lite_profile")
      .eq("id", requestedUserId)
      .maybeSingle();
    if (profErr || !profile) return jsonResp({ error: "profile_not_found" }, 404);
    userId = profile.id;
    userEmail = profile.email;
    isLite = !!profile.is_lite_profile;
  } else {
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData?.user) {
      return new Response("Unauthorized", { status: 401, headers: corsHeaders });
    }
    userId = userData.user.id;
    userEmail = userData.user.email ?? null;
    if (isGhostEmail(userEmail)) {
      isLite = true;
    } else {
      const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const { data: profile } = await admin
        .from("profiles")
        .select("is_lite_profile, email")
        .eq("id", userId)
        .maybeSingle();
      if (profile?.is_lite_profile) {
        isLite = true;
        userEmail = profile.email ?? userEmail;
      }
    }
  }

  // ---------- Resolve price + provider gating ------------------------------
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: priceRes, error: priceErr } = await admin.rpc("resolve_payment_price", {
    p_user_id: userId,
  });
  if (priceErr) {
    console.error("resolve_payment_price failed", priceErr);
    return jsonResp({ error: "price_resolution_failed", details: priceErr.message }, 500);
  }
  if (!priceRes?.ok) {
    return jsonResp({ error: priceRes?.reason ?? "price_resolution_failed" }, 400);
  }

  const amountRub: number       = Number(priceRes.amount_rub);
  const foundingIntent: boolean = !!priceRes.founding_intent;
  const alreadyFounding: boolean = !!priceRes.already_founding;
  const foundingLocale: string | null = priceRes.locale ?? null;
  const allowedProvider: string | null = priceRes.allowed_provider ?? null;

  // Provider gating: if founding_intent OR already_founding constraint applies,
  // the locale MUST allow yookassa. EN founding → reject with a clear pointer.
  if ((foundingIntent || alreadyFounding) && allowedProvider && allowedProvider !== "yookassa") {
    return jsonResp({
      error: "wrong_provider_for_founding",
      message: "This founding membership is locked to Telegram Stars. " +
               "Please open @BelfedBot and use the Subscribe button there.",
      allowed_provider: allowedProvider,
      locale: foundingLocale,
    }, 409);
  }

  // ---------- Build YooKassa payload ---------------------------------------
  const description = (foundingIntent || alreadyFounding)
    ? "BelFed Analytics — Founding Member subscription (1 month)"
    : "BelFed Analytics — subscription (1 month)";

  const idempotenceKey = crypto.randomUUID();
  const returnUrl: string = (body.return_url || RETURN_URL).toString();

  const receipt: Record<string, any> = {
    items: [{
      description,
      quantity: "1.00",
      amount: { value: amountRub.toFixed(2), currency: "RUB" },
      vat_code: 1,
      payment_subject: "service",
      payment_mode: "full_prepayment",
    }],
  };

  if (userEmail && !isGhostEmail(userEmail) && !isLite) {
    receipt.customer = { email: userEmail };
  }

  const payload: Record<string, any> = {
    amount: { value: amountRub.toFixed(2), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    description,
    metadata: {
      user_id: userId,
      plan: "month",
      period_months: 1,
      is_lite_at_payment: isLite,
      // Founding tracking — webhook reads these to decide whether to call claim_founding_slot
      founding_intent:    foundingIntent ? "1" : "0",
      already_founding:   alreadyFounding ? "1" : "0",
      founding_locale:    foundingLocale ?? "",
    },
    receipt,
  };
  if (SAVE_PM) payload.save_payment_method = true;

  const res = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + btoa(`${SHOP_ID}:${SECRET_KEY}`),
      "Idempotence-Key": idempotenceKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("YooKassa create payment failed", res.status, txt);
    return jsonResp({ error: "yookassa_error", details: txt }, 502);
  }

  const payment = await res.json();
  return jsonResp({
    id: payment.id,
    status: payment.status,
    confirmation_url: payment.confirmation?.confirmation_url ?? null,
    is_lite: isLite,
    // Surface founding info to clients (bot/web can show different copy)
    amount_rub: amountRub,
    founding_intent: foundingIntent,
    already_founding: alreadyFounding,
  });
});
