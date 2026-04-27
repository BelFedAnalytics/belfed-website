// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: yookassa-webhook
// Receives HTTP notifications from YooKassa (IP-allowlisted) and:
//   1. deduplicates via payment_events
//   2. on payment.succeeded -> RPC apply_successful_payment (extends access)
//   3. upserts subscriptions row with saved payment_method_id (for recurring)
//   4. invites linked Telegram user to the paid channel
//   5. handles payment.canceled, refund.succeeded
//
// REQUIRED SECRETS:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   YOOKASSA_MODE                "test" | "live"
//   TELEGRAM_BOT_TOKEN           bot token for inviting users
//   TELEGRAM_PAID_CHAT_ID        signed chat id, e.g. -1003660492325
//
// IMPORTANT: Deploy this function with `--no-verify-jwt` so YooKassa can POST.
//     supabase functions deploy yookassa-webhook --no-verify-jwt
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODE             = Deno.env.get("YOOKASSA_MODE") ?? "test";
const IS_LIVE          = MODE === "live";

const TG_TOKEN         = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const PAID_CHAT_ID     = Deno.env.get("TELEGRAM_PAID_CHAT_ID") ?? "";

// https://yookassa.ru/developers/using-api/webhooks#ip
const YOOKASSA_CIDRS_V4 = [
  "185.71.76.0/27", "185.71.77.0/27",
  "77.75.153.0/25", "77.75.156.11/32", "77.75.156.35/32", "77.75.154.128/25",
];
const YOOKASSA_CIDR_V6 = "2a02:5180::/32";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

function ipv4ToInt(ip: string) {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
function ipInCidrV4(ip: string, cidr: string) {
  if (cidr.includes(":")) return false;
  const [range, bitsStr] = cidr.split("/");
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const rangeInt = ipv4ToInt(range);
  if (ipInt === null || rangeInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}
function ipInCidrV6(ip: string, cidr: string) {
  // very loose v6 prefix check — only enabled for Yookassa's 2a02:5180::/32
  if (!ip.includes(":")) return false;
  const prefix = cidr.split("/")[0].toLowerCase().replace(/::$/, "");
  return ip.toLowerCase().startsWith(prefix);
}
function ipAllowed(ip: string) {
  if (!ip) return false;
  if (YOOKASSA_CIDRS_V4.some((c) => ipInCidrV4(ip, c))) return true;
  if (ipInCidrV6(ip, YOOKASSA_CIDR_V6)) return true;
  return false;
}

async function tg(method: string, body: Record<string, any>) {
  if (!TG_TOKEN) return { ok: false, description: "no_bot_token" };
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await r.json().catch(() => ({ ok: false }));
}

async function inviteLinkedTelegramUser(userId: string) {
  if (!TG_TOKEN || !PAID_CHAT_ID) return;
  const { data: prof } = await admin
    .from("profiles")
    .select("telegram_id")
    .eq("id", userId)
    .maybeSingle();
  const chatId = Number(PAID_CHAT_ID);
  const tgId = prof?.telegram_id ? Number(prof.telegram_id) : null;
  if (!tgId) return; // user hasn't linked yet — bot's own /start will grant access later

  // 1) lift ban if previously kicked
  await tg("unbanChatMember", { chat_id: chatId, user_id: tgId, only_if_banned: true });

  // 2) single-use invite link
  const res: any = await tg("createChatInviteLink", {
    chat_id: chatId,
    member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 3600,
    name: `paid:${userId.slice(0, 8)}`,
  });
  const link = res?.result?.invite_link;

  // 3) DM the user with the invite link
  if (link) {
    await tg("sendMessage", {
      chat_id: tgId,
      text:
        "✅ Оплата получена — добро пожаловать в BelFed Analytics.\n\n" +
        "Ваша персональная ссылка-приглашение (действует 1 час, одноразовая):\n" + link,
      disable_web_page_preview: true,
    });
    await admin.from("telegram_access_log").insert({
      user_id: userId, telegram_id: tgId, chat_id: chatId,
      action: "invite", result: "ok", detail: link,
    });
  } else {
    await admin.from("telegram_access_log").insert({
      user_id: userId, telegram_id: tgId, chat_id: chatId,
      action: "invite", result: "error", detail: JSON.stringify(res),
    });
  }
}

async function upsertSubscription(opts: {
  userId: string;
  plan: string;
  amountRub: number;
  months: number;
  paymentMethodId: string | null;
  newExpiry: string;
}) {
  const { userId, plan, amountRub, paymentMethodId, newExpiry } = opts;
  const { data: existing } = await admin
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle();

  const patch: Record<string, any> = {
    user_id: userId,
    plan_code: plan,
    plan: plan,
    amount_rub: amountRub,
    provider: "yookassa",
    status: "active",
    current_period_end: newExpiry,
    next_billing_at:    newExpiry,
    cancel_at_period_end: false,
    cancel_reason: null,
    failed_attempts: 0,
    last_charge_error: null,
    updated_at: new Date().toISOString(),
  };
  if (paymentMethodId) patch.payment_method_id = paymentMethodId;

  if (existing?.id) {
    await admin.from("subscriptions").update(patch).eq("id", existing.id);
  } else {
    await admin.from("subscriptions").insert(patch);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const xff = req.headers.get("x-forwarded-for") ?? "";
  const ip  = xff.split(",")[0].trim();
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

  // Deduplicate
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
      const plan   = String(obj.metadata?.plan ?? "month");
      const months = Number(obj.metadata?.period_months ?? 1);
      const paidAt = obj.captured_at ?? new Date().toISOString();

      const { data: newExpiry, error: rpcErr } = await admin.rpc("apply_successful_payment", {
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

      const paymentMethodId: string | null =
        obj.payment_method?.saved && obj.payment_method?.id ? obj.payment_method.id : null;

      await upsertSubscription({
        userId, plan, amountRub: amount, months,
        paymentMethodId,
        newExpiry: (newExpiry as string) ?? paidAt,
      });

      const isInitial = obj.metadata?.initial === "1";
      if (!isInitial) {
        await admin.from("payments").update({ is_recurring: true })
          .eq("provider", "yookassa").eq("provider_payment_id", paymentId);
      }

      // ---- Capture receipt email + promote lite-profile to full -------------
      // YooKassa returns the customer email it collected on the payment page in:
      //   obj.receipt_registration.customer.email  (after receipt is registered)
      //   obj.receipt.customer.email               (when included in our request)
      // Fallback: obj.payer.email (rarely used)
      const receiptEmail: string | null =
        obj?.receipt_registration?.customer?.email
        ?? obj?.receipt?.customer?.email
        ?? obj?.payer?.email
        ?? null;

      if (receiptEmail) {
        // Save on the payment row (audit)
        await admin.from("payments").update({ receipt_email: receiptEmail })
          .eq("provider", "yookassa").eq("provider_payment_id", paymentId);

        // If user is still lite (ghost email) — promote to full account
        const { data: prof } = await admin
          .from("profiles")
          .select("is_lite_profile, email")
          .eq("id", userId)
          .maybeSingle();

        if (prof?.is_lite_profile) {
          const { data: promoteRes, error: promoteErr } = await admin.rpc("promote_lite_to_full", {
            p_user_id: userId,
            p_real_email: receiptEmail,
          });
          if (promoteErr) {
            console.error("promote_lite_to_full failed:", promoteErr);
          } else {
            console.log("promote_lite_to_full result:", promoteRes);
          }
        }
      }

      // Grant Telegram access (first payment OR re-activation)
      await inviteLinkedTelegramUser(userId).catch((e) => console.error("tg invite failed", e));
    }
    else if (eventType === "payment.canceled") {
      await admin.from("payments").update({
        status: "canceled",
        canceled_at: new Date().toISOString(),
        raw_event: body,
      }).eq("provider", "yookassa").eq("provider_payment_id", paymentId);

      // On recurring failure, bump failed_attempts
      const userId = obj.metadata?.user_id as string | undefined;
      if (userId && obj.metadata?.initial !== "1") {
        const { data: sub } = await admin
          .from("subscriptions").select("id, failed_attempts")
          .eq("user_id", userId).maybeSingle();
        if (sub?.id) {
          await admin.from("subscriptions").update({
            failed_attempts: (sub.failed_attempts ?? 0) + 1,
            last_charge_error: obj.cancellation_details?.reason ?? "canceled",
            last_charge_attempt_at: new Date().toISOString(),
          }).eq("id", sub.id);
        }
      }
    }
    else if (eventType === "refund.succeeded") {
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
    await admin.from("payment_events").update({ processing_error: msg })
      .eq("provider", "yookassa").eq("provider_event_id", eventId);
    // Return 200 anyway so YooKassa doesn't retry for 24h on bugs we already logged.
    return new Response("logged", { status: 200 });
  }
});
