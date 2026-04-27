// deno-lint-ignore-file no-explicit-any
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
const PRICE_RUB          = Number(Deno.env.get("PRICE_MONTHLY_RUB") ?? "1500");
const SAVE_PM            = (Deno.env.get("SAVE_PAYMENT_METHOD") ?? "false").toLowerCase() === "true";
const BOT_SHARED_SECRET  = Deno.env.get("BOT_SHARED_SECRET") ?? "";

const RETURN_URL = "https://belfed.ru/members.html?payment=return";

const MONTHLY = { amount: PRICE_RUB, months: 1, description: "BelFed Analytics — подписка на 1 месяц" };
const PLANS: Record<string, { amount: number; months: number; description: string }> = {
  month:   MONTHLY,
  monthly: MONTHLY,
  "1m":    MONTHLY,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bot-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const isGhostEmail = (e: string | null | undefined) =>
  !!e && /@belfed\.local$/i.test(e);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const body = await req.json().catch(() => ({}));
  const planKey: string = (body.plan ?? "month").toString();
  const p = PLANS[planKey];
  if (!p) {
    return new Response(JSON.stringify({ error: `Unknown plan: ${planKey}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // ---------- Auth ---------------------------------------------------------
  // Two paths:
  // 1. Bot call: x-bot-secret header matches, body must contain user_id (uuid)
  // 2. User call: Authorization: Bearer <jwt> from website
  let userId: string | null = null;
  let userEmail: string | null = null;
  let isLite = false;

  const incomingBotSecret = req.headers.get("x-bot-secret") ?? "";
  if (BOT_SHARED_SECRET && incomingBotSecret === BOT_SHARED_SECRET) {
    // Bot path — trusted
    const requestedUserId = (body.user_id ?? "").toString().trim();
    if (!requestedUserId) {
      return new Response(JSON.stringify({ error: "user_id_required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: profile, error: profErr } = await admin
      .from("profiles")
      .select("id, email, is_lite_profile")
      .eq("id", requestedUserId)
      .maybeSingle();
    if (profErr || !profile) {
      return new Response(JSON.stringify({ error: "profile_not_found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    userId = profile.id;
    userEmail = profile.email;
    isLite = !!profile.is_lite_profile;
  } else {
    // User path — JWT
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
    // Detect lite (ghost email) even if site somehow lets a lite user log in
    if (isGhostEmail(userEmail)) {
      isLite = true;
    } else {
      // Double-check via profiles.is_lite_profile
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

  // ---------- Build YooKassa payload --------------------------------------
  const idempotenceKey = crypto.randomUUID();
  const returnUrl: string = (body.return_url || RETURN_URL).toString();

  const receipt: Record<string, any> = {
    items: [{
      description: p.description,
      quantity: "1.00",
      amount: { value: p.amount.toFixed(2), currency: "RUB" },
      vat_code: 1,
      payment_subject: "service",
      payment_mode: "full_prepayment",
    }],
  };

  // For full users with real email — pre-fill receipt customer.
  // For lite users (ghost email) — DO NOT pre-fill; YooKassa will collect email
  // on the payment page and return it in payment.receipt.customer.email
  if (userEmail && !isGhostEmail(userEmail) && !isLite) {
    receipt.customer = { email: userEmail };
  }

  const payload: Record<string, any> = {
    amount: { value: p.amount.toFixed(2), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    description: p.description,
    metadata: {
      user_id: userId,
      plan: "month",
      period_months: p.months,
      is_lite_at_payment: isLite,
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
    return new Response(JSON.stringify({ error: "yookassa_error", details: txt }), {
      status: 502,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const payment = await res.json();
  return new Response(JSON.stringify({
    id: payment.id,
    status: payment.status,
    confirmation_url: payment.confirmation?.confirmation_url ?? null,
    is_lite: isLite,
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
