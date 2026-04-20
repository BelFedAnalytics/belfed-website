// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODE             = Deno.env.get("YOOKASSA_MODE") ?? "test";

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

      const { error } = await admin.rpc("apply_successful_payment", {
        p_provider_payment_id: paymentId,
        p_user_id: userId,
        p_amount: amount,
        p_currency: obj.amount.currency,
        p_plan: plan,
        p_period_months: months,
        p_paid_at: obj.captured_at ?? new Date().toISOString(),
        p_raw: body,
        p_is_test: MODE !== "live",
      });
      if (error) throw error;
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
      processed: true, processed_at: new Date().toISOString(),
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
