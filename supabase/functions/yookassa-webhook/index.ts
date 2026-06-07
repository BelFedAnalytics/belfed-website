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
const PAID_CHAT_ID     = Deno.env.get("TELEGRAM_PAID_CHAT_ID") ?? "";              // RU paid (default)
const PAID_CHAT_ID_EN  = Deno.env.get("TELEGRAM_PAID_CHAT_ID_EN") ?? "";           // EN paid (optional)

// Admin Telegram IDs to notify on every successful YooKassa payment.
// Source of truth: ADMIN_TELEGRAM_IDS env (comma-separated). Fallback: Artem.
const ADMIN_TG_IDS: number[] = (
  (Deno.env.get("ADMIN_TELEGRAM_IDS") ?? "118296372")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
);

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
    .select("telegram_id, lang")
    .eq("id", userId)
    .maybeSingle();
  const tgId = prof?.telegram_id ? Number(prof.telegram_id) : null;
  if (!tgId) return; // user hasn't linked yet — bot's own /start will grant access later

  const lang = (prof?.lang === "en") ? "en" : "ru";
  const chatId = Number(
    lang === "en" && PAID_CHAT_ID_EN ? PAID_CHAT_ID_EN : PAID_CHAT_ID
  );

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

  // 3) DM the user with the invite link (localized RU/EN)
  if (link) {
    const text = lang === "en"
      ? "✅ Payment received — welcome to BelFed Analytics.\n\n" +
        "Your personal invite link (valid 1 hour, single-use):\n" + link
      : "✅ Оплата получена — добро пожаловать в BelFed Analytics.\n\n" +
        "Ваша персональная ссылка-приглашение (действует 1 час, одноразовая):\n" + link;
    await tg("sendMessage", {
      chat_id: tgId,
      text,
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

// Format an ISO timestamp as DD.MM.YYYY (UTC) for admin-readable messages.
function fmtExpiryDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const yyyy = d.getUTCFullYear();
    return `${dd}.${mm}.${yyyy}`;
  } catch { return "—"; }
}

function brandLast4(brand: string | null, last4: string | null): string {
  if (!brand && !last4) return "—";
  const b = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : "Card";
  return last4 ? `${b} •••• ${last4}` : b;
}

async function notifyAdminsNewPayment(opts: {
  userId: string;
  paymentId: string;
  amount: number;
  currency: string;
  plan: string;
  newExpiry: string;
  isRecurring: boolean;
  foundingIntent: boolean;
  foundingClaimRes: any;
  foundingClaimOk: boolean;
  cardLast4: string | null;
  cardBrand: string | null;
  paymentMethodSaved: boolean;
  receiptEmail: string | null;
}) {
  if (!TG_TOKEN || ADMIN_TG_IDS.length === 0) return;

  // Fetch profile snapshot for richer message (best-effort).
  const { data: prof } = await admin
    .from("profiles")
    .select("id, email, telegram_id, telegram_username, lang, founding_member, founding_locale")
    .eq("id", opts.userId)
    .maybeSingle();

  const tgUsername = prof?.telegram_username ? `@${prof.telegram_username}` : "—";
  const tgId = prof?.telegram_id ?? "—";
  const email = prof?.email ?? opts.receiptEmail ?? "—";
  const lang = prof?.lang ?? "—";

  // Founding line. If claim succeeded now, or user is already founding
  // (idempotent re-charge / recurring), surface that. Also surface failure
  // reasons so admin can investigate (e.g. quota_exhausted, invalid_locale).
  let foundingLine = "Type: Standard subscription";
  if (opts.foundingIntent) {
    if (opts.foundingClaimOk) {
      foundingLine = "Type: Founding Member 🌟 (just granted)";
    } else if (prof?.founding_member) {
      foundingLine = "Type: Founding Member 🌟 (already, renewal/recurring)";
    } else {
      const reason = (opts.foundingClaimRes && (opts.foundingClaimRes as any).reason) || "unknown";
      foundingLine = `Type: Standard — founding_intent set but claim failed (${reason})`;
    }
  } else if (prof?.founding_member) {
    // Founding user on a recurring charge — keep the badge visible.
    foundingLine = "Type: Founding Member 🌟 (recurring charge)";
  }

  const recurringStr = opts.isRecurring ? "yes (auto-renew charge)" : "one-time / initial";
  const amountStr = `${opts.amount} ${opts.currency}`;
  const card = brandLast4(opts.cardBrand, opts.cardLast4);
  const savedStr = opts.paymentMethodSaved ? "saved (auto-renew enabled)" : "not saved (one-time)";
  const expStr = fmtExpiryDate(opts.newExpiry);

  const text =
    "💰 New paid subscription (YooKassa)\n" +
    "\n" +
    `User: ${tgUsername}\n` +
    `TG ID: ${tgId}\n` +
    `Email: ${email}\n` +
    `Lang: ${lang}\n` +
    `Profile: ${opts.userId}\n` +
    "\n" +
    `${foundingLine}\n` +
    `Provider: YooKassa\n` +
    `Amount: ${amountStr}\n` +
    `Plan: ${opts.plan}\n` +
    `Recurring: ${recurringStr}\n` +
    `Card: ${card}\n` +
    `Payment method: ${savedStr}\n` +
    "\n" +
    `Subscription until: ${expStr}\n` +
    `Payment ID: ${opts.paymentId}`;

  for (const adminTg of ADMIN_TG_IDS) {
    try {
      await tg("sendMessage", {
        chat_id: adminTg,
        text,
        disable_web_page_preview: true,
      });
    } catch (e) {
      console.error(`admin notify: failed to send to ${adminTg}: ${(e as Error).message}`);
    }
  }
}

async function upsertSubscription(opts: {
  userId: string;
  plan: string;
  amountRub: number;
  months: number;
  paymentMethodId: string | null;
  cardLast4: string | null;
  cardBrand: string | null;
  newExpiry: string;
}) {
  const { userId, plan, amountRub, paymentMethodId, cardLast4, cardBrand, newExpiry } = opts;
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
  if (paymentMethodId) {
    patch.payment_method_id = paymentMethodId;
    // Mark as freshly attached. If the user previously detached and is now
    // attaching again (new card via new checkout), reset detached_at.
    patch.payment_method_saved_at    = new Date().toISOString();
    patch.payment_method_detached_at = null;
  }
  if (cardLast4) patch.card_last4 = cardLast4;
  if (cardBrand) patch.card_brand = cardBrand;

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

      // Card metadata for the /billing UI. YooKassa returns it nested under
      // payment_method.card. Both fields are best-effort: SBP/other methods
      // won't have them, and that's fine — UI handles NULL gracefully.
      //
      // NOTE: we capture last4/brand regardless of payment_method.saved.
      // Even non-recurring (saved=false) payments display in the user's
      // /billing page so they can see what card paid. The recurring/auto-
      // renewal capability is governed separately by payment_method_id
      // (which we only persist when saved=true above).
      const card = obj.payment_method?.card ?? null;
      const cardLast4: string | null =
        card?.last4 && /^\d{4}$/.test(String(card.last4)) ? String(card.last4) : null;
      const cardBrand: string | null =
        card?.card_type ? String(card.card_type).toLowerCase() : null;

      await upsertSubscription({
        userId, plan, amountRub: amount, months,
        paymentMethodId, cardLast4, cardBrand,
        newExpiry: (newExpiry as string) ?? paidAt,
      });

      // ---- Founding-slot claim (if user paid with founding_intent) ----------
      // Set on yookassa-create-payment when resolve_payment_price returned
      // founding_intent=true. We re-verify by calling claim_founding_slot,
      // which is atomic (FOR UPDATE on founding_quota). Outcomes:
      //   - ok:true                    → slot granted, profile flipped to founding
      //   - already_founding           → user already had a slot (idempotent)
      //   - quota_exhausted            → race lost; logged, but payment stands
      //   - invalid_locale / not_found → defensive, logged
      // We never throw here — the payment is already applied; founding is bonus.
      const foundingIntent = obj.metadata?.founding_intent === "1";
      const foundingLocale = (obj.metadata?.founding_locale ?? "").toString();
      let foundingClaimRes: any = null;
      let foundingClaimOk = false;
      if (foundingIntent && (foundingLocale === "ru" || foundingLocale === "en")) {
        try {
          const { data: claimRes, error: claimErr } = await admin.rpc("claim_founding_slot", {
            p_user_id: userId,
            p_locale:  foundingLocale,
            p_source:  "paid_checkout_yookassa",
            p_notes:   `payment_id=${paymentId}, amount=${amount} RUB`,
          });
          if (claimErr) {
            console.error("claim_founding_slot RPC error", claimErr);
            await admin.from("payment_events").update({
              processing_error: `founding_claim_rpc_error: ${claimErr.message ?? JSON.stringify(claimErr)}`,
            }).eq("provider", "yookassa").eq("provider_event_id", eventId);
          } else {
            console.log("claim_founding_slot result", JSON.stringify(claimRes));
            foundingClaimRes = claimRes;
            foundingClaimOk = !!(claimRes && (claimRes as any).ok === true);
          }
        } catch (e) {
          const m = (e as Error).message;
          console.error("claim_founding_slot failed", m);
          await admin.from("payment_events").update({
            processing_error: `founding_claim_exception: ${m}`,
          }).eq("provider", "yookassa").eq("provider_event_id", eventId);
        }
        // Clean up the pending claim row regardless of outcome
        await admin.from("pending_founding_claims").delete().eq("user_id", userId);
      }

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

      // ---- Admin DM notification (every successful YooKassa payment) --------
      // Mirrors the Telegram-Stars admin notification produced by bot.py's
      // notify_admins_new_subscription so Artem (and any other listed admin)
      // sees a single consistent format for every paid event regardless of
      // payment rail. Best-effort: errors are logged, never re-thrown — a
      // failed admin DM must not roll back the user's payment.
      try {
        await notifyAdminsNewPayment({
          userId,
          paymentId,
          amount,
          currency: obj.amount?.currency ?? "RUB",
          plan,
          newExpiry: (newExpiry as string) ?? paidAt,
          isRecurring: !isInitial,
          foundingIntent,
          foundingClaimRes,
          foundingClaimOk,
          cardLast4,
          cardBrand,
          paymentMethodSaved: !!obj.payment_method?.saved,
          receiptEmail,
        });
      } catch (e) {
        console.error("notifyAdminsNewPayment failed", (e as Error).message);
      }
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
