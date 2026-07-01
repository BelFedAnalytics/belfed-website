// trial-bot-reminders v7 — staged trial reminders at T-5 / T-3 / T-1 days
//
// v7: All three stages now share the SAME three Founding-Member benefit bullets
//     (BULLETS_EN / BULLETS_RU), including the "up-to-30-day pause keeps your
//     discount + status" bullet. RU T-1 wording "торговым сетапам" replaced
//     with "торговым возможностям" (EN keeps "trading setups").
//
// v6: Founding-Member CTA is an inline keyboard button (⭐) under the
//     message on every stage; the public track-record link appears only on
//     the final (T-1) reminder.
//
// Reads public.users_for_trial_reminder_staged (one row per due stage),
// sends the matching bilingual DM with a Telegram-native Tribute payment link,
// and stamps the matching profiles.trial_rem_d{5,3,1}_sent_at column so each
// stage fires exactly once per trial. Driven by a daily cron.
//
// Manual test: POST { "force_telegram_id": 123456, "force_stage": 5, "force_lang": "ru" }
//
// SECRETS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TG_TOKEN     = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

// Telegram-native Tribute links (open inside Telegram app)
const FM_LINK_RU = "https://t.me/tribute/app?startapp=sXHG";
const FM_LINK_EN = "https://t.me/tribute/app?startapp=sXIq";

// Public "Track record" page (no paywall) — used as the optional stats link
const STATS_LINK_RU = "https://belfed.ru/trades.html";
const STATS_LINK_EN = "https://belfed.com/trades.html";

const SENT_COL: Record<number, string> = {
  5: "trial_rem_d5_sent_at",
  3: "trial_rem_d3_sent_at",
  1: "trial_rem_d1_sent_at",
};

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

function fmtDate(iso: string, lang: "ru" | "en"): string {
  return new Date(iso).toLocaleDateString(lang === "en" ? "en-US" : "ru-RU", {
    day: lang === "en" ? "numeric" : "2-digit",
    month: "long",
  });
}

// ─── Message texts ───────────────────────────────────────────────
// T-5: soft heads-up + founding offer. T-3: value reminder. T-1: last-chance urgency.

type Msg = { text: string; btnText: string };

// Shared Founding Member benefit bullets (identical across all three stages)
const BULLETS_EN =
  "\u2022 30% lifetime discount off the current price \u2014 *$10.50/mo*\n" +
  "\u2022 x3 priority asset requests per day, plus priority processing\n" +
  "\u2022 Founding Member status tied to your account: if you ever need to pause, you'll have up to 30 days to come back without losing your discount or status";
const BULLETS_RU =
  "\u2022 \u041f\u043e\u0436\u0438\u0437\u043d\u0435\u043d\u043d\u0430\u044f \u0441\u043a\u0438\u0434\u043a\u0430 30% \u043e\u0442 \u0442\u0435\u043a\u0443\u0449\u0435\u0433\u043e \u043f\u0440\u0430\u0439\u0441-\u043b\u0438\u0441\u0442\u0430 \u2014 *1 050 \u20bd/\u043c\u0435\u0441*\n" +
  "\u2022 x3 \u043f\u0440\u0438\u043e\u0440\u0438\u0442\u0435\u0442\u043d\u044b\u0445 \u0437\u0430\u043f\u0440\u043e\u0441\u0430 \u043d\u0430 \u0430\u043d\u0430\u043b\u0438\u0437 \u0430\u043a\u0442\u0438\u0432\u043e\u0432 \u0432 \u0434\u0435\u043d\u044c \u0438 \u043f\u0440\u0438\u043e\u0440\u0438\u0442\u0435\u0442 \u0432 \u0438\u0445 \u043e\u0431\u0440\u0430\u0431\u043e\u0442\u043a\u0435\n" +
  "\u2022 \u0421\u0442\u0430\u0442\u0443\u0441 Founding Member \u0437\u0430\u043a\u0440\u0435\u043f\u043b\u0451\u043d \u0437\u0430 \u0430\u043a\u043a\u0430\u0443\u043d\u0442\u043e\u043c: \u043f\u0440\u0438 \u043d\u0435\u043e\u0431\u0445\u043e\u0434\u0438\u043c\u043e\u0441\u0442\u0438 \u043f\u0430\u0443\u0437\u044b \u0443 \u0432\u0430\u0441 \u0435\u0441\u0442\u044c \u0434\u043e 30 \u0434\u043d\u0435\u0439, \u0447\u0442\u043e\u0431\u044b \u0432\u0435\u0440\u043d\u0443\u0442\u044c\u0441\u044f \u0431\u0435\u0437 \u043f\u043e\u0442\u0435\u0440\u0438 \u0441\u043a\u0438\u0434\u043a\u0438 \u0438 \u0441\u0442\u0430\u0442\u0443\u0441\u0430";

function msgD5(lang: "ru" | "en", ends: string): Msg {
  if (lang === "en") return {
    text:
      "\u23f3 Your BelFed trial ends on *" + ends + "* (in 5 days).\n\n" +
      "As a thank-you to our earliest subscribers, we've opened 50 exclusive Founding Member seats:\n\n" +
      BULLETS_EN,
    btnText: "\u2b50 Become a Founding Member",
  };
  return {
    text:
      "\u23f3 \u0412\u0430\u0448 \u043f\u0440\u043e\u0431\u043d\u044b\u0439 \u0434\u043e\u0441\u0442\u0443\u043f \u043a BelFed \u0437\u0430\u043a\u0430\u043d\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044f *" + ends + "* (\u0447\u0435\u0440\u0435\u0437 5 \u0434\u043d\u0435\u0439).\n\n" +
      "\u0412 \u0437\u043d\u0430\u043a \u0431\u043b\u0430\u0433\u043e\u0434\u0430\u0440\u043d\u043e\u0441\u0442\u0438 \u043d\u0430\u0448\u0438\u043c \u043f\u0435\u0440\u0432\u044b\u043c \u043f\u043e\u0434\u043f\u0438\u0441\u0447\u0438\u043a\u0430\u043c \u043c\u044b \u0432\u044b\u0434\u0435\u043b\u0438\u043b\u0438 50 \u044d\u043a\u0441\u043a\u043b\u044e\u0437\u0438\u0432\u043d\u044b\u0445 \u043c\u0435\u0441\u0442 \u043d\u0430 \u0443\u0441\u043b\u043e\u0432\u0438\u044f\u0445 Founding Member (\u0441\u043e-\u043e\u0441\u043d\u043e\u0432\u0430\u0442\u0435\u043b\u0438 \u0441\u0435\u0440\u0432\u0438\u0441\u0430):\n\n" +
      BULLETS_RU,
    btnText: "\u2b50 \u0421\u0442\u0430\u0442\u044c Founding Member",
  };
}

function msgD3(lang: "ru" | "en", ends: string): Msg {
  if (lang === "en") return {
    text:
      "\ud83d\udccc Your BelFed trial ends on *" + ends + "* (in 3 days).\n\n" +
      "What Founding Members lock in for good:\n\n" +
      BULLETS_EN +
      "\n\nOnly 50 seats \u2014 and they're going fast. Claim yours.",
    btnText: "\u2b50 Become a Founding Member",
  };
  return {
    text:
      "\ud83d\udccc \u0412\u0430\u0448 \u043f\u0440\u043e\u0431\u043d\u044b\u0439 \u0434\u043e\u0441\u0442\u0443\u043f \u043a BelFed \u0437\u0430\u043a\u0430\u043d\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044f *" + ends + "* (\u0447\u0435\u0440\u0435\u0437 3 \u0434\u043d\u044f).\n\n" +
      "\u0427\u0442\u043e \u0441\u043e-\u043e\u0441\u043d\u043e\u0432\u0430\u0442\u0435\u043b\u0438 \u0437\u0430\u043a\u0440\u0435\u043f\u043b\u044f\u044e\u0442 \u0437\u0430 \u0441\u043e\u0431\u043e\u0439 \u043d\u0430\u0432\u0441\u0435\u0433\u0434\u0430:\n\n" +
      BULLETS_RU +
      "\n\n\u041c\u0435\u0441\u0442 \u043d\u0435\u043c\u043d\u043e\u0433\u043e \u2014 50 \u043d\u0430 \u0432\u0441\u0435\u0445. \u0423\u0441\u043f\u0435\u0439\u0442\u0435 \u0437\u0430\u043d\u044f\u0442\u044c \u0441\u0432\u043e\u0451.",
    btnText: "\u2b50 \u0421\u0442\u0430\u0442\u044c Founding Member",
  };
}

function msgD1(lang: "ru" | "en", ends: string): Msg {
  if (lang === "en") return {
    text:
      "\ud83d\udd14 Your BelFed trial ends *tomorrow* (" + ends + "). Access to analytics and trading setups closes after that.\n\n" +
      "Last chance to lock in Founding Member terms:\n\n" +
      BULLETS_EN +
      `\n\n\ud83d\udcca [See our trade track record \u2192](${STATS_LINK_EN})`,
    btnText: "\u2b50 Become a Founding Member",
  };
  return {
    text:
      "\ud83d\udd14 \u0412\u0430\u0448 \u043f\u0440\u043e\u0431\u043d\u044b\u0439 \u0434\u043e\u0441\u0442\u0443\u043f \u043a BelFed \u0437\u0430\u043a\u0430\u043d\u0447\u0438\u0432\u0430\u0435\u0442\u0441\u044f *\u0437\u0430\u0432\u0442\u0440\u0430* (" + ends + "). \u041f\u043e\u0441\u043b\u0435 \u044d\u0442\u043e\u0433\u043e \u0434\u043e\u0441\u0442\u0443\u043f \u043a \u0430\u043d\u0430\u043b\u0438\u0442\u0438\u043a\u0435 \u0438 *\u0442\u043e\u0440\u0433\u043e\u0432\u044b\u043c \u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e\u0441\u0442\u044f\u043c* \u0437\u0430\u043a\u0440\u043e\u0435\u0442\u0441\u044f.\n\n" +
      "\u041f\u043e\u0441\u043b\u0435\u0434\u043d\u044f\u044f \u0432\u043e\u0437\u043c\u043e\u0436\u043d\u043e\u0441\u0442\u044c \u0437\u0430\u0444\u0438\u043a\u0441\u0438\u0440\u043e\u0432\u0430\u0442\u044c \u0443\u0441\u043b\u043e\u0432\u0438\u044f Founding Member:\n\n" +
      BULLETS_RU +
      `\n\n\ud83d\udcca [\u0421\u043c\u043e\u0442\u0440\u0435\u0442\u044c \u0441\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a\u0443 \u043d\u0430\u0448\u0438\u0445 \u0441\u0434\u0435\u043b\u043e\u043a \u2192](${STATS_LINK_RU})`,
    btnText: "\u2b50 \u041f\u0435\u0440\u0435\u0439\u0442\u0438 \u043d\u0430 Founding Member",
  };
}

function buildMsg(stage: number, lang: "ru" | "en", ends: string): Msg {
  if (stage === 5) return msgD5(lang, ends);
  if (stage === 3) return msgD3(lang, ends);
  return msgD1(lang, ends);
}

// ─── Main handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  // Manual test path
  const forceTgId = body.force_telegram_id != null ? String(body.force_telegram_id) : null;
  const forceStage = typeof body.force_stage === "number" ? body.force_stage as 5 | 3 | 1 : null;
  const forceLang = typeof body.force_lang === "string" && ["ru", "en"].includes(body.force_lang)
    ? body.force_lang as "ru" | "en" : null;

  if (forceTgId && forceStage) {
    const lang = forceLang ?? "ru";
    const link = lang === "en" ? FM_LINK_EN : FM_LINK_RU;
    const ends = fmtDate(new Date(Date.now() + forceStage * 86400000).toISOString(), lang);
    const m = buildMsg(forceStage, lang, ends);
    const res = await sendTg(forceTgId, m.text, { text: m.btnText, url: link });
    return json({ ok: res.ok, stage: forceStage, lang, link, error: res.error });
  }

  const { data: list, error } = await admin
    .from("users_for_trial_reminder_staged")
    .select("user_id, telegram_id, lang, trial_end, stage")
    .limit(500);
  if (error) return json({ error: error.message }, 500);

  const results: Array<Record<string, unknown>> = [];
  for (const row of list ?? []) {
    const lang: "ru" | "en" = row.lang === "en" ? "en" : "ru";
    const link = lang === "en" ? FM_LINK_EN : FM_LINK_RU;
    const ends = fmtDate(row.trial_end as string, lang);
    const stage = Number(row.stage);
    const m = buildMsg(stage, lang, ends);
    const res = await sendTg(row.telegram_id as string, m.text, { text: m.btnText, url: link });
    if (res.ok) {
      await admin.from("profiles")
        .update({ [SENT_COL[stage]]: new Date().toISOString() })
        .eq("id", row.user_id as string);
      results.push({ stage, user: row.user_id, lang, status: "sent" });
    } else {
      results.push({ stage, user: row.user_id, lang, status: "error", error: res.error });
    }
  }

  return json({ ok: true, sent: results.filter((r) => r.status === "sent").length, results });
});
