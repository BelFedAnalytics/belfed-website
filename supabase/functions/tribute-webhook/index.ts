// deno-lint-ignore-file no-explicit-any
//
// Supabase Edge Function: tribute-webhook  (v8)
// v7: routes payments via apply_successful_payment RPC with p_provider='tribute'
// v8: (a) normalizes amount from minor units (kopecks/cents) to major units (RUB/USD)
//         before writing to DB — Tribute's webhook spec says amounts are always in
//         smallest currency unit; YooKassa sends major units. Store major units
//         everywhere so UI can share a single fmtRub() helper.
//     (b) uses eventId (per-event) instead of subscriptionId (per-sub) as the
//         provider_payment_id so subscription_renewed events produce new payment
//         rows in history rather than overwriting the initial one.
// =================================================================
// Receives webhooks from Tribute (https://tribute.tg) and:
//   1. (optional) verifies HMAC-SHA256 signature if a signing key env is set
//   2. deduplicates via payment_events (provider='tribute', provider_event_id)
//   3. resolves the BelFed user by telegram_user_id (fallback: provision lite)
//   4. extends paid access via RPC apply_successful_payment(..., p_provider=>'tribute')
//      — the RPC now writes payments.provider='tribute' and upserts a
//      subscriptions row scoped to provider='tribute'. No more phantom
//      'yookassa' rows created for Tribute events.
//   5. invites the linked Telegram user to the correct paid chat (RU/EN)
//   6. notifies admins
//   7. handles cancellation events
//
// verify_jwt MUST be false (Tribute cannot send a Supabase JWT).
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---- Safe env reads (never throw at startup) --------------------------------
const SUPABASE_URL      = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG_TOKEN          = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

const PAID_CHAT_ID      = Deno.env.get("TELEGRAM_PAID_CHAT_ID")    ?? "-1003773738299"; // RU
const PAID_CHAT_ID_EN   = Deno.env.get("TELEGRAM_PAID_CHAT_ID_EN") ?? "-1003869302680"; // EN

const TRIBUTE_SIGNING_KEY =
  Deno.env.get("TRIBUTE_API_KEY") ??
  Deno.env.get("TRIBUTE_WEBHOOK_SECRET") ??
  Deno.env.get("TRIBUTE_SIGNING_KEY") ??
  "";

const ADMIN_TG_IDS: number[] = (Deno.env.get("ADMIN_TELEGRAM_IDS") ?? "118296372")
  .split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// ---- helpers ----------------------------------------------------------------
async function tg(method: string, body: Record<string, any>) {
  if (!TG_TOKEN) return { ok: false, description: "no_bot_token" };
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await r.json().catch(() => ({ ok: false, description: "parse_error" }));
  } catch (e) {
    return { ok: false, description: (e as Error).message };
  }
}

function pickChatId(lang: string): number {
  return Number(lang === "en" ? PAID_CHAT_ID_EN : PAID_CHAT_ID);
}

function periodToMonths(period: string | null | undefined): number {
  const p = String(period ?? "").toLowerCase();
  if (p === "quarterly" || p === "3months") return 3;
  if (p === "6months" || p === "halfyearly") return 6;
  if (p === "yearly" || p === "annual" || p === "12months") return 12;
  return 1;
}

function fmtExpiryDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    const dd = String(d.getUTCDate()).padStart(2, "0");
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${dd}.${mm}.${d.getUTCFullYear()}`;
  } catch { return "—"; }
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacHex(key: string, raw: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(raw));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function inviteUser(userId: string, lang: string) {
  if (!TG_TOKEN) return;
  const { data: prof } = await admin
    .from("profiles").select("telegram_id, lang").eq("id", userId).maybeSingle();
  const tgId = prof?.telegram_id ? Number(prof.telegram_id) : null;
  if (!tgId) return;
  const effLang = (prof?.lang === "en") ? "en" : (lang === "en" ? "en" : "ru");
  const chatId = pickChatId(effLang);
  if (!chatId) return;

  await tg("unbanChatMember", { chat_id: chatId, user_id: tgId, only_if_banned: true });
  const res: any = await tg("createChatInviteLink", {
    chat_id: chatId, member_limit: 1,
    expire_date: Math.floor(Date.now() / 1000) + 3600,
    name: `paid:${userId.slice(0, 8)}`,
  });
  const link = res?.result?.invite_link;
  if (link) {
    const text = effLang === "en"
      ? "✅ Payment received — welcome to BelFed Analytics.\n\nYour personal invite link (valid 1 hour, single-use):\n" + link
      : "✅ Оплата получена — добро пожаловать в BelFed Analytics.\n\nВаша персональная ссылка-приглашение (действует 1 час, одноразовая):\n" + link;
    await tg("sendMessage", { chat_id: tgId, text, disable_web_page_preview: true });
    try {
      await admin.from("telegram_access_log").insert({
        user_id: userId, telegram_id: tgId, chat_id: chatId,
        action: "invite", result: "ok", detail: `tribute paid; ${link}`,
      });
    } catch (_) { /* log table optional */ }
  }
}

async function notifyAdmins(opts: {
  userId: string; tgUsername: string | null; tgId: string | number | null;
  email: string | null; lang: string; amount: number; currency: string;
  plan: string; newExpiry: string; subscriptionId: string | number;
}) {
  if (!TG_TOKEN || ADMIN_TG_IDS.length === 0) return;
  const text =
    "💰 New paid subscription (Tribute)\n\n" +
    `User: ${opts.tgUsername ? "@" + opts.tgUsername : "—"}\n` +
    `TG ID: ${opts.tgId ?? "—"}\n` +
    `Email: ${opts.email ?? "—"}\n` +
    `Lang: ${opts.lang}\n` +
    `Profile: ${opts.userId}\n\n` +
    `Provider: Tribute\n` +
    `Amount: ${opts.amount} ${opts.currency}\n` +
    `Plan: ${opts.plan}\n` +
    `Subscription until: ${fmtExpiryDate(opts.newExpiry)}\n` +
    `Tribute sub id: ${opts.subscriptionId}`;
  for (const a of ADMIN_TG_IDS) {
    try { await tg("sendMessage", { chat_id: a, text, disable_web_page_preview: true }); }
    catch (_) { /* best-effort */ }
  }
}

async function resolveUserId(p: {
  telegramId: string | null; telegramUsername: string | null;
  email: string | null; lang: string;
}): Promise<string | null> {
  if (p.telegramId) {
    const { data: found } = await admin.rpc("find_profile_by_telegram", {
      p_telegram_id: p.telegramId, p_telegram_username: p.telegramUsername,
    });
    const id = (found && (found as any).id) ? (found as any).id : null;
    if (id) return id;
  }

  if (p.telegramId && /^\d+$/.test(p.telegramId)) {
    try {
      const { data: claim } = await admin.rpc("claim_trial_by_telegram", {
        p_telegram_id: p.telegramId,
        p_telegram_username: p.telegramUsername,
        p_trial_days: 0,
        p_source: "tribute_payment",
        p_lang: p.lang,
      });
      const uid = (claim as any)?.user_id ?? null;
      if (uid) {
        if (p.email) {
          try {
            await admin.rpc("link_telegram_email", {
              p_telegram_id: p.telegramId, p_email: p.email,
              p_telegram_username: p.telegramUsername,
            });
          } catch (_) { /* non-fatal */ }
        }
        return uid;
      }
    } catch (e) {
      console.error("tribute provision failed", (e as Error).message);
    }
  }
  return null;
}

// ---- main handler -----------------------------------------------------------
Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("ok", { status: 200 });
  }

  const raw = await req.text().catch(() => "");
  let body: any = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

  if (body && body.test_event) {
    return new Response("ok", { status: 200 });
  }

  if (TRIBUTE_SIGNING_KEY) {
    const sigHeader =
      req.headers.get("trbt-signature") ??
      req.headers.get("x-tribute-signature") ??
      req.headers.get("tribute-signature") ?? "";
    let ok = false;
    try {
      const expected = await hmacHex(TRIBUTE_SIGNING_KEY, raw);
      const provided = sigHeader.trim().toLowerCase().replace(/^sha256=/, "");
      ok = !!provided && safeEqual(expected, provided);
    } catch (e) {
      console.error("hmac compute failed", (e as Error).message);
    }
    if (!ok) {
      console.warn("tribute-webhook: signature mismatch");
      return new Response("invalid signature", { status: 401 });
    }
  } else {
    console.warn("tribute-webhook: no signing key configured — skipping HMAC");
  }

  const eventName: string = body?.name ?? "";
  const pl: any = body?.payload ?? {};
  const subscriptionId = pl?.subscription_id ?? pl?.period_id ?? null;
  const eventId = `${eventName}:${subscriptionId ?? "na"}:${pl?.expires_at ?? body?.sent_at ?? ""}`;

  try {
    const { data: seen } = await admin
      .from("payment_events")
      .select("id, processed")
      .eq("provider", "tribute")
      .eq("provider_event_id", eventId)
      .maybeSingle();
    if (seen?.processed) return new Response("ok", { status: 200 });

    await admin.from("payment_events").upsert({
      provider: "tribute",
      provider_event_id: eventId,
      event_type: eventName,
      provider_payment_id: subscriptionId ? String(subscriptionId) : null,
      payload: body,
    }, { onConflict: "provider,provider_event_id" });
  } catch (e) {
    console.error("payment_events persist failed", (e as Error).message);
  }

  try {
    if (eventName === "cancelled_subscription" || eventName === "subscription_cancelled") {
      const subId = subscriptionId ? String(subscriptionId) : null;
      if (subId) {
        await admin.from("subscriptions").update({
          cancel_at_period_end: true,
          cancel_reason: "tribute_cancelled",
          updated_at: new Date().toISOString(),
        }).eq("provider", "tribute").eq("provider_subscription_id", subId);
      }
      await admin.from("payment_events").update({
        processed: true, processed_at: new Date().toISOString(),
      }).eq("provider", "tribute").eq("provider_event_id", eventId);
      return new Response("ok", { status: 200 });
    }

    if (eventName === "new_subscription" || eventName === "subscription_renewed") {
      const lang = String(pl?.currency).toLowerCase() === "usd" ? "en" : "ru";
      const telegramId = pl?.telegram_user_id != null ? String(pl.telegram_user_id) : null;
      const telegramUsername = pl?.telegram_username ? String(pl.telegram_username) : null;
      const email = pl?.email ? String(pl.email) : null;
      const months = periodToMonths(pl?.period);
      const currency = String(pl?.currency ?? "rub").toUpperCase();
      // Tribute sends amounts in the smallest currency unit (kopecks for RUB, cents for USD/EUR)
      // per https://wiki.tribute.tg/for-shops/api/webhooks and /api/methods.
      // Our downstream storage (payments.amount, subscriptions.amount_rub) is in major units
      // (rubles), matching the YooKassa webhook. Divide by 100 here so the DB stays consistent
      // across providers and the UI can render amounts with a single fmtRub() everywhere.
      const amountMinorUnits = Number(pl?.amount ?? pl?.price ?? 0);
      const amount = Math.round(amountMinorUnits) / 100;
      const paidAt = body?.created_at ?? body?.sent_at ?? new Date().toISOString();
      const plan = lang === "en" ? "month_intl" : "month";

      const userId = await resolveUserId({ telegramId, telegramUsername, email, lang });
      if (!userId) {
        await admin.from("payment_events").update({
          processing_error: `could not resolve/provision user (tg=${telegramId}, email=${email})`,
        }).eq("provider", "tribute").eq("provider_event_id", eventId);
        for (const a of ADMIN_TG_IDS) {
          await tg("sendMessage", {
            chat_id: a,
            text: `⚠️ Tribute payment could not be linked to a user.\nTG: ${telegramId}\nEmail: ${email}\nSub: ${subscriptionId}\nPlease link manually.`,
          });
        }
        return new Response("ok", { status: 200 });
      }

      // v7 change: single source of truth for payment + subscription is the
      // RPC apply_successful_payment (now provider-aware). We NO LONGER perform
      // a secondary subscriptions upsert here — that was the source of the
      // duplicate-subscription bug.
      let newExpiry: string | null = null;
      let rpcOk = false;
      try {
        // provider_payment_id must be unique per PAYMENT (not per subscription) so that
        // subscription_renewed events produce new rows in payments rather than upserting
        // the initial one. Tribute's webhook events are individually unique via eventId.
        // Fall back to sub id only if eventId is somehow missing (defensive).
        const providerPaymentId = eventId
          ? `tribute:evt:${eventId}`
          : (subscriptionId ? `tribute:sub:${subscriptionId}:${paidAt}` : `tribute:${paidAt}`);
        const { data: exp, error: rpcErr } = await admin.rpc("apply_successful_payment", {
          p_provider_payment_id: providerPaymentId,
          p_user_id: userId,
          p_amount: amount,
          p_currency: currency,
          p_plan: plan,
          p_period_months: months,
          p_paid_at: paidAt,
          p_raw: body,
          p_is_test: false,
          p_provider: "tribute",
        });
        if (rpcErr) throw rpcErr;
        newExpiry = (exp as string) ?? null;
        rpcOk = true;
      } catch (e) {
        console.error("apply_successful_payment failed", (e as Error).message);
        await admin.from("payment_events").update({
          processing_error: `apply_successful_payment: ${(e as Error).message}`,
        }).eq("provider", "tribute").eq("provider_event_id", eventId);
      }

      // Tribute-specific attributes not handled by the generic RPC:
      //   - provider_subscription_id must be the *plain* Tribute sub id
      //     (RPC seeds it with providerPaymentId for the first insert, so we
      //      overwrite here; used for cancellation lookups).
      //   - provider_customer_id = Tribute internal user id
      //   - next_billing_at should track Tribute's declared expires_at
      //   - amount is normalized to major units before the RPC call (see above)
      if (rpcOk) {
        const tributeExpiry = pl?.expires_at ?? null;
        const billingExpiry = tributeExpiry ?? newExpiry ?? paidAt;
        try {
          await admin.from("subscriptions").update({
            provider_subscription_id: subscriptionId ? String(subscriptionId) : null,
            provider_customer_id: pl?.user_id != null ? String(pl.user_id) : null,
            next_billing_at: billingExpiry,
            currency: String(pl?.currency ?? "rub").toLowerCase(),
            updated_at: new Date().toISOString(),
          })
          .eq("user_id", userId)
          .eq("provider", "tribute")
          .eq("status", "active");
        } catch (e) {
          console.error("tribute-specific patch failed", (e as Error).message);
        }
      }

      const accessExpiry = newExpiry ?? pl?.expires_at ?? paidAt;

      await inviteUser(userId, lang).catch((e) => console.error("invite failed", e));
      await notifyAdmins({
        userId, tgUsername: telegramUsername, tgId: telegramId, email, lang,
        amount, currency, plan, newExpiry: accessExpiry,
        subscriptionId: subscriptionId ?? "—",
      }).catch(() => {});

      await admin.from("payment_events").update({
        processed: true, processed_at: new Date().toISOString(),
      }).eq("provider", "tribute").eq("provider_event_id", eventId);

      return new Response("ok", { status: 200 });
    }

    await admin.from("payment_events").update({
      processed: true, processed_at: new Date().toISOString(),
    }).eq("provider", "tribute").eq("provider_event_id", eventId);
    return new Response("ok", { status: 200 });

  } catch (e) {
    const msg = (e as Error).message;
    console.error("tribute-webhook error:", msg);
    try {
      await admin.from("payment_events").update({ processing_error: msg })
        .eq("provider", "tribute").eq("provider_event_id", eventId);
    } catch (_) { /* ignore */ }
    return new Response("logged", { status: 200 });
  }
});
