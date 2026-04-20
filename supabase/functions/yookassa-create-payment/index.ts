// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const MODE             = Deno.env.get("YOOKASSA_MODE") ?? "test";
const SHOP_ID = MODE === "live"
  ? Deno.env.get("YOOKASSA_SHOP_ID")!
  : Deno.env.get("YOOKASSA_TEST_SHOP_ID")!;
const SECRET_KEY = MODE === "live"
  ? Deno.env.get("YOOKASSA_SECRET_KEY")!
  : Deno.env.get("YOOKASSA_TEST_SECRET_KEY")!;

const RETURN_URL = "https://belfed.ru/members.html?payment=return";

// TODO: подтвердите итоговые цены и vat_code у бухгалтера.
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

  const { plan = "month" } = await req.json().catch(() => ({}));
  const p = PLANS[plan];
  if (!p) {
    return new Response("Unknown plan", { status: 400, headers: corsHeaders });
  }

  const idempotenceKey = crypto.randomUUID();

  const payload: Record<string, any> = {
    amount: { value: p.amount.toFixed(2), currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: RETURN_URL },
    description: p.description,
    metadata: {
      user_id: user.id,
      plan,
      period_months: p.months,
    },
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
    return new Response(txt, { status: 502, headers: corsHeaders });
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
