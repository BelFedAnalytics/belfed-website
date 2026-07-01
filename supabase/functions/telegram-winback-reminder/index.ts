// telegram-winback-reminder v1 — post-lapse win-back DM (fires once per lapse)
//
// Reads public.users_for_expired_winback (users whose access has lapsed, are not
// Founding Members, and lapsed within the last 30 days) and sends ONE bilingual
// win-back DM. Copy leads with Founding-Member status & privileges (not price)
// and pitches the Founding offer while seats remain; when the 50 seats for the
// user's locale are gone it falls back to a plain renewal nudge. Stamps
// profiles.winback_reminder_sent_at so each lapse is messaged exactly once; the
// view re-arms automatically on a later lapse.
//
// Does NOT kick anyone and does NOT change enforcement — win-back only.
//
// CRON: 30 9 * * *   POST   Authorization: Bearer <SERVICE_ROLE_KEY>
//   (daily, an hour after the founding-renewal reminder; a 6h cron is also safe
//    because the sent-at guard makes each lapse fire once.)
//
// Manual test: POST { "force_telegram_id": 123456, "force_lang": "ru", "force_seats": 12 }
//
// SECRETS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TG_TOKEN     = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

// Telegram-native Tribute links (open inside Telegram app) — Founding Member offer
const FM_LINK_RU = "https://t.me/tribute/app?startapp=sXHG";
const FM_LINK_EN = "https://t.me/tribute/app?startapp=sXIq";

// Plain renewal fallback (no founding seats left) — public members page
const MEMBERS_RU = "https://belfed.ru/members.html#subscribe";
const MEMBERS_EN = "https://belfed.com/members.html#subscribe";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function sendTg(
  chatId: number | string,
  text: string,
  button?: { text: string; url: string },
): Promise<{ ok: boolean; error?: string }> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  if (button) {
    payload.reply_markup = { inline_keyboard: [[{ text: button.text, url: button.url }]] };
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) return { ok: false, error: j.description || "tg error" };
  return { ok: true };
}

type Msg = { text: string; button?: { text: string; url: string } };

// ─── Win-back copy ───────────────────────────────────────────────
// Leads with Founding-Member status & privileges (not price). Founding offer is
// shown only while seats remain; otherwise a plain renewal nudge.

function buildMsg(lang: "ru" | "en", seatsRemaining: number): Msg {
  const founding = seatsRemaining > 0;

  if (lang === "en") {
    if (founding) {
      return {
        text:
          "👋 Your BelFed Analytics access is paused.\n\n" +
          "You were one of our earliest members — so a *Founding Member* seat is still open for you " +
          `(only *${seatsRemaining} of 50* left):\n\n` +
          "• *Founding Member status* tied to your account: if you ever need to pause again, you'll have up to 30 days to come back without losing your status or discount\n" +
          "• *Priority processing* — x3 priority asset-analysis requests per day\n" +
          "• *30% lifetime discount* off the current price — *$10.50/mo* instead of $15, locked in for as long as your subscription stays active\n\n" +
          "Reactivate now and your seat is reserved for good.",
        button: { text: "⭐ Become a Founding Member", url: FM_LINK_EN },
      };
    }
    return {
      text:
        "👋 Your BelFed Analytics access is paused.\n\n" +
        "To get back your analytics, trade ideas and the private channel, renew your subscription — *$15/mo*:\n" +
        MEMBERS_EN,
    };
  }

  if (founding) {
    return {
      text:
        "👋 Ваш доступ к BelFed Analytics приостановлен.\n\n" +
        "Вы были одним из первых подписчиков — поэтому место *Founding Member* (со-основателя сервиса) всё ещё закреплено за вами " +
        `(осталось *${seatsRemaining} из 50*):\n\n` +
        "• *Статус Founding Member* закреплён за аккаунтом: при необходимости паузы у вас есть до 30 дней, чтобы вернуться без потери статуса и скидки\n" +
        "• *Приоритетная обработка* — x3 приоритетных запроса на анализ активов в день\n" +
        "• *Пожизненная скидка 30%* от текущего прайс-листа — *1 050 ₽/мес* вместо 1 500 ₽, пока подписка активна\n\n" +
        "Возобновите сейчас — и место закрепится за вами навсегда.",
      button: { text: "⭐ Стать Founding Member", url: FM_LINK_RU },
    };
  }
  return {
    text:
      "👋 Ваш доступ к BelFed Analytics приостановлен.\n\n" +
      "Чтобы вернуть аналитику, торговые идеи и закрытый канал, оформите подписку — *1 500 ₽/мес*:\n" +
      MEMBERS_RU,
  };
}

// ─── Main handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  // Manual test path
  const forceTgId = body.force_telegram_id != null ? String(body.force_telegram_id) : null;
  const forceLang = typeof body.force_lang === "string" && ["ru", "en"].includes(body.force_lang)
    ? body.force_lang as "ru" | "en" : null;
  const forceSeats = typeof body.force_seats === "number" ? body.force_seats : null;

  if (forceTgId) {
    const lang = forceLang ?? "ru";
    const m = buildMsg(lang, forceSeats ?? 10);
    const res = await sendTg(forceTgId, m.text, m.button);
    return json({ ok: res.ok, lang, seats: forceSeats ?? 10, error: res.error });
  }

  const { data: list, error } = await admin
    .from("users_for_expired_winback")
    .select("user_id, telegram_id, lang, subscription_expires_at, seats_remaining")
    .limit(500);
  if (error) return json({ error: error.message }, 500);

  const results: Array<Record<string, unknown>> = [];
  for (const row of list ?? []) {
    const lang: "ru" | "en" = row.lang === "en" ? "en" : "ru";
    const seats = Number(row.seats_remaining ?? 0);
    const m = buildMsg(lang, seats);
    const res = await sendTg(row.telegram_id as string, m.text, m.button);
    if (res.ok) {
      await admin.from("profiles")
        .update({ winback_reminder_sent_at: new Date().toISOString() })
        .eq("id", row.user_id as string);
      results.push({ user: row.user_id, lang, seats, status: "sent" });
    } else {
      results.push({ user: row.user_id, lang, seats, status: "error", error: res.error });
    }
  }

  return json({ ok: true, sent: results.filter((r) => r.status === "sent").length, results });
});
