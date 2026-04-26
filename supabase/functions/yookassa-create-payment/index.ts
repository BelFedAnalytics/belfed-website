// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: yookassa-create-payment
// Создаёт платёж в YooKassa: единый план 1500 ₽/мес, save_payment_method=true,
// чек 54-ФЗ. Принимает карты + SBP (Yookassa решает по выбору пользователя).
//
// SECRETS:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY     (auto)
//   YOOKASSA_MODE                  "test" | "live"
//   YOOKASSA_TEST_SHOP_ID, YOOKASSA_TEST_SECRET_KEY
//   YOOKASSA_SHOP_ID,      YOOKASSA_SECRET_KEY
//   YOOKASSA_RETURN_URL            https://belfed.ru/members.html?payment=return
//   YOOKASSA_VAT_CODE              "1" (без НДС, УСН) — default
//   YOOKASSA_TAX_SYSTEM            "2" (УСН доходы) — optional
//   PRICE_MONTHLY_RUB              "1500" — single plan price
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MODE     = Deno.env.get("YOOKASSA_MODE") ?? "test";
const IS_LIVE  = MODE === "live";
const SHOP_ID    = IS_LIVE ? Deno.env.get("YOOKASSA_SHOP_ID")!     : Deno.env.get("YOOKASSA_TEST_SHOP_ID")!;
const SECRET_KEY = IS_LIVE ? Deno.env.get("YOOKASSA_SECRET_KEY")! : Deno.env.get("YOOKASSA_TEST_SECRET_KEY")!;

const RETURN_URL = Deno.env.get("YOOKASSA_RETURN_URL") ?? "https://belfed.ru/members.html?payment=return";
const VAT_CODE   = Number(Deno.env.get("YOOKASSA_VAT_CODE") ?? "1");
const TAX_SYSTEM = Deno.env.get("YOOKASSA_TAX_SYSTEM");
const PRICE_RUB  = Number(Deno.env.get("PRICE_MONTHLY_RUB") ?? "1500");

const PLAN = {
  code: "monthly",
  amount: PRICE_RUB,
  months: 1,
  description: "BelFed Analytics — подписка 1 месяц",
};

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

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: u, error: userErr } = await userClient.auth.getUser();
  if (userErr || !u?.user) return json({ error: "unauthorized" }, 401);
  const user = u.user;
  if (!user.email) return json({ error: "email_required_for_receipt" }, 400);

  const body = await req.json().catch(() => ({} as any));
  // payment_method: undefined → Yookassa shows full picker (cards + SBP + YooMoney).
  // Optionally allow client to force "sbp" or "bank_card" for explicit buttons.
  const forced: string | undefined = body?.payment_method;

  const idempotenceKey = crypto.randomUUID();

  const receipt: Record<string, any> = {
    customer: { email: user.email },
    items: [{
      description:     PLAN.description,
      quantity:        "1.00",
      amount:          { value: PLAN.amount.toFixed(2), currency: "RUB" },
      vat_code:        VAT_CODE,
      payment_subject: "service",
      payment_mode:    "full_prepayment",
    }],
  };
  if (TAX_SYSTEM) receipt.tax_system_code = Number(TAX_SYSTEM);

  const payload: Record<string, any> = {
    amount:              { value: PLAN.amount.toFixed(2), currency: "RUB" },
    capture:             true,
    save_payment_method: true,
    confirmation:        { type: "redirect", return_url: RETURN_URL },
    description:         PLAN.description,
    metadata: {
      user_id: user.id,
      plan: PLAN.code,
      period_months: PLAN.months,
      initial: "1",
    },
    receipt,
  };
  if (forced === "sbp" || forced === "bank_card") {
    payload.payment_method_data = { type: forced };
  }

  const res = await fetch("https://api.yookassa.ru/v3/payments", {
    method: "POST",
    headers: {
      "Authorization":   "Basic " + btoa(`${SHOP_ID}:${SECRET_KEY}`),
      "Idempotence-Key": idempotenceKey,
      "Content-Type":    "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("YooKassa create payment failed", res.status, txt);
    return json({ error: "yookassa_error", status: res.status, detail: txt }, 502);
  }

  const payment = await res.json();

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error: insErr } = await admin.from("payments").insert({
    user_id:             user.id,
    provider:            "yookassa",
    provider_payment_id: payment.id,
    amount:              PLAN.amount,
    currency:            "RUB",
    status:              payment.status ?? "pending",
    idempotence_key:     idempotenceKey,
    plan:                PLAN.code,
    period_months:       PLAN.months,
    description:         PLAN.description,
    is_test:             !IS_LIVE,
    receipt_email:       user.email,
  });
  if (insErr) console.error("payments insert failed", insErr);

  return json({
    id:               payment.id,
    status:           payment.status,
    confirmation_url: payment.confirmation?.confirmation_url ?? null,
  });
});
