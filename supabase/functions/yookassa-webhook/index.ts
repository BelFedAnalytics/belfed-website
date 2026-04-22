// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODE              = Deno.env.get("YOOKASSA_MODE") ?? "test";
const IS_LIVE           = MODE === "live";

// Verify against https://yookassa.ru/developers/using-api/webhooks#ip
const YOOKASSA_CIDRS = [
  "185.71.76.0/27",
  "185.71.77.0/27",
  "77.75.153.0/25",
  "77.75.156.11/32",
  "77.75.156.35/32",
  "77.75.154.128/25",
];

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function ipInCidr(ip: string, cidr: string): boolean {
  if (cidr.includes(":")) return false;
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}
function ipAllowed(ip: string): boolean {
  if (!ip) return false;
  return YOOKASSA_CIDRS.some((c) => ipInCidr(ip, c));
}

// Upsert subscription record capturing saved payment method for recurring charges.
async function upsertSubscription(opts: {
  userId: string;
  plan: string;
  amountRub: number;
  months: number;
  paymentMethodId: string | null;
  newExpiry: string;
}) {
  const { userId, plan, amountRub, months, paymentMethodId, newExpiry } = opts;

  const { data: existing } = await admin
    .from("subscriptions")
    .select("id, payment_method_id, status")
    .eq("user_id", userId)
    .maybeSingle();

  const patch: Record<string, any> = {
    user_id: userId,
    plan_code: plan,
    amount_rub: amountRub,
    provider: "yookassa",
    status: "active",
    current_period_end: newExpiry,
    next_billing_at: newExpiry,
    cancel_at_period_end: false,
    cancel_reason: null,
    updated_at: new Date().toISOString(),
  };
  // Only overwrite payment_method_id if we have a new one (saved card).
  if (paymentMethodId) patch.payment_method_id = paymentMethodId;

  if (existing?.id) {
    await admin.from("subscriptions").update(patch).eq("id", existing.id);
  } else {
    await admin.from("subscriptions").insert(patch);
  }
  void months; // kept for future per-plan logic
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip = xff.split(",")[0].trim();
  if (!ipAllowed(ip)) {
    console.warn("yookassa-webhook: IP not allowed", ip);
    return new Response("Forbidden", { status: 403 });
  }

  let body: any;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  const eventType: string = body.event;
  const obj = body.object ?? {};
  const paymentId: string = obj.id;
  const eventId: string = body.event_id ?? `${paymentId}:${eventType}`;

  const { data: seen } = await admin
    .from("payment_events")
    .select("id, processed")
    .eq("provider", "yookassa")
    .eq("provider_event_id", eventId)
    .maybeSingle();
  if (seen?.processed) return new Response("ok", { status: 200 });

  await admin.from("payment_events").upsert({
    provider: "yookassa",
    provider_event_id: eventId,
    event_type: eventType,
    provider_payment_id: paymentId,
    payload: body,
  }, { onConflict: "provider,provider_event_id" });

  try {
    if (eventType === "payment.succeeded" && obj.status === "succeeded" && obj.paid) {
      const userId = obj.metadata?.user_id as string | undefined;
      if (!userId) throw new Error("metadata.user_id missing");
      const amount = Number(obj.amount.value);
      const plan = String(obj.metadata?.plan ?? "month");
      const months = Number(obj.metadata?.period_months ?? 1);
      const paidAt = obj.captured_at ?? new Date().toISOString();

      // 1. Atomic DB write for payment + profile expiry (existing RPC).
      const { error: rpcErr } = await admin.rpc("apply_successful_payment", {
        p_provider_payment_id: paymentId,
        p_user_id: userId,
        p_amount: amount,
        p_currency: obj.amount.currency,
        p_plan: plan,
        p_period_months: months,
        p_paid_at: paidAt,
        p_raw: body,
        p_is_test: !IS_LIVE,
      });
      if (rpcErr) throw rpcErr;

      // 2. Read the new expiry written by the RPC.
      const { data: prof } = await admin
        .from("profiles")
        .select("subscription_expires_at")
        .eq("id", userId)
        .maybeSingle();
      const newExpiry = prof?.subscription_expires_at ?? paidAt;

      // 3. Upsert subscription row with saved payment method id (for recurring cron).
      const paymentMethodId: string | null =
        obj.payment_method?.saved && obj.payment_method?.id ? obj.payment_method.id : null;
      await upsertSubscription({
        userId, plan, amountRub: amount, months, paymentMethodId, newExpiry,
      });

      // 4. Mark the payment row as recurring if this was an auto-charge (not the initial).
      const isInitial = obj.metadata?.initial === "1";
      if (!isInitial) {
        await admin.from("payments").update({ is_recurring: true })
          .eq("provider", "yookassa").eq("provider_payment_id", paymentId);
      }
    } else if (eventType === "payment.canceled") {
      await admin.from("payments").update({
        status: "canceled",
        canceled_at: new Date().toISOString(),
        raw_event: body,
      }).eq("provider", "yookassa").eq("provider_payment_id", paymentId);
    } else if (eventType === "refund.succeeded") {
      const srcId = obj.payment_id as string;
      await admin.from("payments").update({
        status: "refunded",
        refunded_at: new Date().toISOString(),
        raw_event: body,
      }).eq("provider", "yookassa").eq("provider_payment_id", srcId);
    }

    await admin.from("payment_events").update({
      processed: true,
      processed_at: new Date().toISOString(),
    }).eq("provider", "yookassa").eq("provider_event_id", eventId);

    return new Response("ok", { status: 200 });
  } catch (e) {
    const msg = (e as Error).message;
    console.error("yookassa-webhook error:", msg);
    await admin.from("payment_events").update({
      processing_error: msg,
    }).eq("provider", "yookassa").eq("provider_event_id", eventId);
    return new Response("logged", { status: 200 });
  }
});
