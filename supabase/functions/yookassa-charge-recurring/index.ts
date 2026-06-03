// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: yookassa-charge-recurring
// Scheduled cron: every 6 hours.
// For every active subscription with a saved payment_method_id whose
// next_billing_at is within 24h, create a new YooKassa payment charging
// that saved method. Payment captures immediately; webhook handles the rest.
//
// CRON (Supabase dashboard -> Edge Functions -> Scheduled):
//   Name:     charge-recurring
//   Schedule: 0 */6 * * *
//   Function: yookassa-charge-recurring
//   Method:   POST
//   Header:   Authorization: Bearer <SERVICE_ROLE_KEY>
//
// Deploy with `--no-verify-jwt` OR keep JWT verification and pass service role token.
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODE             = Deno.env.get("YOOKASSA_MODE") ?? "test";
const IS_LIVE          = MODE === "live";
const SHOP_ID    = IS_LIVE ? Deno.env.get("YOOKASSA_SHOP_ID")!     : Deno.env.get("YOOKASSA_TEST_SHOP_ID")!;
const SECRET_KEY = IS_LIVE ? Deno.env.get("YOOKASSA_SECRET_KEY")! : Deno.env.get("YOOKASSA_TEST_SECRET_KEY")!;
const VAT_CODE   = Number(Deno.env.get("YOOKASSA_VAT_CODE") ?? "1");
const TAX_SYSTEM = Deno.env.get("YOOKASSA_TAX_SYSTEM");

// Pricing is RESOLVED per-user via RPC `resolve_payment_price`. Founding members
// pay the discounted rate; standard members pay the standard rate; if standard
// price has been raised recently, founding members keep paying the previous-
// founding rate for 30 days (grace window) before flipping to the new founding
// rate. All of this is handled inside the RPC.

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function chargeOne(sub: any) {
  const plan = "monthly";

  // Resolve current per-user price (founding discount, grace, etc.)
  const { data: priceRes, error: priceErr } = await admin.rpc("resolve_payment_price", {
    p_user_id: sub.user_id,
  });
  if (priceErr) throw new Error(`resolve_price_error: ${priceErr.message}`);
  if (!priceRes?.ok)  throw new Error(`resolve_price_failed: ${priceRes?.reason ?? "unknown"}`);

  // Provider gating: if the resolved price says this user is locked to Stars
  // (i.e. founding EN), we must NOT charge them via YooKassa. Skip silently and
  // log — they'll renew through Telegram instead. This is defense in depth;
  // EN-locked users shouldn't have a YooKassa payment_method_id at all.
  if (priceRes.allowed_provider && priceRes.allowed_provider !== "yookassa") {
    console.warn(`skip user=${sub.user_id} sub=${sub.id} — locked to ${priceRes.allowed_provider}`);
    await admin.from("subscriptions").update({
      last_charge_attempt_at: new Date().toISOString(),
      last_charge_error: `skipped: locked to ${priceRes.allowed_provider}`,
    }).eq("id", sub.id);
    return null;
  }

  const amountRub: number = Number(priceRes.amount_rub);
  const description = (priceRes.already_founding || priceRes.founding_intent)
    ? "BelFed Analytics — Founding Member, продление 1 месяц"
    : "BelFed Analytics — продление подписки 1 месяц";
  const p = { amount: amountRub, months: 1, description };

  // Fetch the user's email for 54-FZ receipt
  const { data: userRow } = await admin.auth.admin.getUserById(sub.user_id);
  const email = userRow?.user?.email;
  if (!email) throw new Error("no_email_for_receipt");

  // Idempotence key includes the RESOLVED amount so a re-run after a price
  // change won't collide with the previous attempt.
  const idempotenceKey = `rec_${sub.id}_${new Date(sub.next_billing_at).toISOString().slice(0, 10)}_${amountRub}`;

  const receipt: Record<string, any> = {
    customer: { email },
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

  const payload = {
    amount:            { value: p.amount.toFixed(2), currency: "RUB" },
    capture:           true,
    payment_method_id: sub.payment_method_id,   // <-- recurring charge
    description:       p.description,
    metadata: {
      user_id: sub.user_id,
      plan,
      period_months: p.months,
      initial: "0",
      subscription_id: sub.id,
      // Recurring charges never carry founding_intent (the founding slot, if any,
      // was already claimed on the initial payment). Surface already_founding so
      // the webhook can log it but won't re-claim.
      already_founding: priceRes.already_founding ? "1" : "0",
      founding_locale:  priceRes.locale ?? "",
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
    throw new Error(`yookassa_${res.status}: ${txt.slice(0, 300)}`);
  }
  const payment = await res.json();

  await admin.from("payments").insert({
    user_id: sub.user_id,
    provider: "yookassa",
    provider_payment_id: payment.id,
    amount:   p.amount,
    currency: "RUB",
    status:   payment.status ?? "pending",
    idempotence_key: idempotenceKey,
    plan,
    period_months: p.months,
    description:   p.description,
    is_test: !IS_LIVE,
    is_recurring: true,
    receipt_email: email,
  });

  await admin.from("subscriptions").update({
    last_charge_attempt_at: new Date().toISOString(),
    last_charge_error: null,
  }).eq("id", sub.id);

  return payment.id;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const { data: due, error } = await admin
    .from("subscriptions_due_for_charge")
    .select("*")
    .limit(200);
  if (error) return new Response(error.message, { status: 500 });

  const results: any[] = [];
  for (const sub of due ?? []) {
    try {
      const pid = await chargeOne(sub);
      results.push({ sub: sub.id, ok: true, payment: pid });
    } catch (e) {
      const msg = (e as Error).message;
      console.error("charge failed for", sub.id, msg);

      const fails = (sub.failed_attempts ?? 0) + 1;
      const patch: Record<string, any> = {
        failed_attempts: fails,
        last_charge_attempt_at: new Date().toISOString(),
        last_charge_error: msg.slice(0, 500),
        updated_at: new Date().toISOString(),
      };
      // After 4 failures, give up and mark subscription as past_due
      if (fails >= 4) {
        patch.status = "past_due";
        patch.cancel_at_period_end = true;
      }
      await admin.from("subscriptions").update(patch).eq("id", sub.id);
      results.push({ sub: sub.id, ok: false, error: msg });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }), {
    headers: { "Content-Type": "application/json" },
  });
});
