// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: yookassa-create-payment
// Creates a YooKassa payment, saves the payment method for recurring charges,
// attaches a fiscal receipt (54-FZ), and records a pending payment row.
//
// REQUIRED SECRETS (Supabase -> Project Settings -> Edge Functions -> Secrets):
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY        (auto)
//   YOOKASSA_MODE                      "test" or "live"
//   YOOKASSA_TEST_SHOP_ID, YOOKASSA_TEST_SECRET_KEY
//   YOOKASSA_SHOP_ID,      YOOKASSA_SECRET_KEY
//   YOOKASSA_RETURN_URL    e.g. https://belfed.ru/members.html?payment=return
//   YOOKASSA_VAT_CODE      "1" (без НДС, УСН) — default
//   YOOKASSA_TAX_SYSTEM    "2" (УСН доходы) — optional
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MODE     = Deno.env.get("YOOKASSA_MODE") ?? "test";
const IS_LIVE  = MODE === "live";
const SHOP_ID    = IS_LIVE ? Deno.env.get("YOOKASSA_SHOP_ID")!     : Deno.env.get("YOOKASSA_TEST_SHOP_ID")!;
const SECRET_KEY = IS_LIVE ? Deno.env.get("YOOKASSA_SECRET_KEY")! : Deno.env.get("YOOKASSA_TEST_SECRET_KEY")!;

const RETURN_URL   = Deno.env.get("YOOKASSA_RETURN_URL")
                  ?? "https://belfed.ru/members.html?payment=return";
const VAT_CODE     = Number(Deno.env.get("YOOKASSA_VAT_CODE") ?? "1");  // 1 = без НДС
const TAX_SYSTEM   = Deno.env.get("YOOKASSA_TAX_SYSTEM"); // optional "2" for УСН доходы

const PLANS: Record<string, { amount: number; months: number; description: string }> = {
  month:   { amount: 2990,  months: 1,  description: "BelFed Analytics — подписка 1 месяц" },
  quarter: { amount: 7990,  months: 3,  description: "BelFed Analytics — подписка 3 месяца" },
  year:    { amount: 24990, months: 12, description: "BelFed Analytics — подписка 12 месяцев" },
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

  // Authenticate caller
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
  const plan: string = body?.plan ?? "month";
  const p = PLANS[plan];
  if (!p) return json({ error: "unknown_plan" }, 400);

  const idempotenceKey = crypto.randomUUID();

  const receipt: Record<string, any> = {
    customer: { email: user.email },
    items: [{
      description:     p.description,
      quantity:        "1.00",
      amount:          { value: p.amount.toFixed(2), currency: "RUB" },
      vat_code:        VAT_CODE,
      payment_subject: "service",
      payment_mode:    "full_prepayment",
    }],
  };
  if (TAX_SYSTEM) receipt.tax_system_code = Number(TAX_SYSTEM);

  const payload: Record<string, any> = {
    amount:              { value: p.amount.toFixed(2), currency: "RUB" },
    capture:             true,
    save_payment_method: true,  // enables recurring
    confirmation:        { type: "redirect", return_url: RETURN_URL },
    description:         p.description,
    metadata: {
      user_id:       user.id,
      plan,
      period_months: p.months,
      initial:       "1",
    },
    receipt,
  };

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

  // Persist pending payment row (service role bypasses RLS)
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { error: insErr } = await admin.from("payments").insert({
    user_id:             user.id,
    provider:            "yookassa",
    provider_payment_id: payment.id,
    amount:              p.amount,
    currency:            "RUB",
    status:              payment.status ?? "pending",
    idempotence_key:     idempotenceKey,
    plan,
    period_months:       p.months,
    description:         p.description,
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
