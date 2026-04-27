// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const MODE = Deno.env.get("YOOKASSA_MODE") ?? "test";
const SHOP_ID = MODE === "live"
  ? Deno.env.get("YOOKASSA_SHOP_ID")!
  : Deno.env.get("YOOKASSA_TEST_SHOP_ID")!;
const SECRET_KEY = MODE === "live"
  ? Deno.env.get("YOOKASSA_SECRET_KEY")!
  : Deno.env.get("YOOKASSA_TEST_SECRET_KEY")!;
const PRICE_RUB = Number(Deno.env.get("PRICE_MONTHLY_RUB") ?? "1500");
// SAVE_PAYMENT_METHOD=true только когда менеджер ЮKassa активирует рекуррент.
// По умолчанию выключено — обычная разовая оплата.
const SAVE_PM = (Deno.env.get("SAVE_PAYMENT_METHOD") ?? "false").toLowerCase() === "true";

const RETURN_URL = "https://belfed.ru/members.html?payment=return";

const MONTHLY = { amount: PRICE_RUB, months: 1, description: "BelFed Analytics — подписка на 1 месяц" };
const PLANS: Record<string, { amount: number; months: number; description: string }> = {
  month:   MONTHLY,
  monthly: MONTHLY,
  "1m":    MONTHLY,
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }
  const user = userData.user;

  const body = await req.json().catch(() => ({}));
  const planKey: string = (body.plan ?? "month").toString();
  const p = PLANS[planKey];
  if (!p) {
    return new Response(JSON.stringify({ error: `Unknown plan: ${planKey}` }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const idempotenceKey = crypto.randomUUID();
  const returnUrl: string = (body.return_url || RETURN_URL).toString();

  const payload: Record<string, any> = {
    amount: { value: p.amount.toFixed(2), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    description: p.description,
    metadata: { user_id: user.id, plan: "month", period_months: p.months },
    receipt: {
      customer: { email: user.email },
      items: [{
        description: p.description,
        quantity: "1.00",
        amount: { value: p.amount.toFixed(2), currency: "RUB" },
        vat_code: 1,
        payment_subject: "service",
        payment_mode: "full_prepayment",
      }],
    },
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
  }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
