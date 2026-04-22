// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY          = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODE              = Deno.env.get("YOOKASSA_MODE") ?? "test";
const IS_LIVE           = MODE === "live";
const SHOP_ID   = IS_LIVE ? Deno.env.get("YOOKASSA_SHOP_ID")!     : Deno.env.get("YOOKASSA_TEST_SHOP_ID")!;
const SECRET_KEY = IS_LIVE ? Deno.env.get("YOOKASSA_SECRET_KEY")! : Deno.env.get("YOOKASSA_TEST_SECRET_KEY")!;

const RETURN_URL = "https://belfed.ru/members.html?payment=return";

// Prices confirmed by accountant; vat_code=1 = without VAT (УСН).
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

function json(body: unknown, status = 200) {
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

  const body = await req.json().catch(() => ({} as any));
  const plan: string = body?.plan ?? "month";
  const p = PLANS[plan];
  if (!p) {
    return new Response("Unknown plan", { status: 400, headers: corsHeaders });
  }

  const idempotenceKey = crypto.randomUUID();

  // YooKassa payload: first charge enables save_payment_method for recurring charges.
  const payload: Record<string, any> = {
    amount: { value: p.amount.toFixed(2), currency: "RUB" },
    capture: true,
    save_payment_method: true,
    confirmation: { type: "redirect", return_url: RETURN_URL },
    description: p.description,
    metadata: {
      user_id: user.id,
      plan,
      period_months: p.months,
      initial: "1",
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

  // Persist a pending payment row using service role (bypasses RLS for server writes).
  try {
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const { error: insErr } = await admin.from("payments").insert({
      user_id: user.id,
      provider: "yookassa",
      provider_payment_id: payment.id,
      amount: p.amount,
      currency: "RUB",
      status: payment.status ?? "pending",
      idempotence_key: idempotenceKey,
      plan,
      period_months: p.months,
      description: p.description,
      is_test: !IS_LIVE,
    });
    if (insErr) console.error("payments insert failed", insErr);
  } catch (e) {
    console.error("payments insert threw", e);
  }

  return json({
    id: payment.id,
    status: payment.status,
    confirmation_url: payment.confirmation?.confirmation_url ?? null,
  });
});
