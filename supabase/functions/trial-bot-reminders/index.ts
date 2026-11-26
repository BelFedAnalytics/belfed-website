// trial-bot-reminders v11 — staged trial reminders at T-5 / T-3 / T-1 days
//
// v11: three behaviour fixes found while auditing the funnel on 26 Aug 2026.
//   1. Segmentation by in_group. Roughly nine of ten trials never entered the
//      closed group, so the old message pitched a subscription to people who
//      had seen almost nothing. Those users now get the invite first, and the
//      payment offer only on the final day.
//   2. A hard Telegram block now stamps the stage. Before this the send failed,
//      the stamp stayed null, and the cron retried the same blocked user every
//      day forever. With a measured 46 percent block rate that was most of the
//      daily volume.
//   3. Stats link moved from trades.html (crypto and commodities only) to
//      results.html, which also shows the equities track record. EN has no
//      combined page, so it gets both links.
//   Copy fixes: the founding bullet said "1 request per day", the agreed terms
//   are one request with priority processing. Em-dashes removed from
//   user-facing text.
//
// Reads public.users_for_trial_reminder_staged (one row per due stage), sends
// the matching bilingual DM with a Telegram-native Tribute payment link, and
// stamps the matching profiles.trial_rem_d{5,3,1}_sent_at column so each stage
// fires exactly once per trial. Driven by a daily cron.
//
// Manual test: POST { "force_telegram_id": 123456, "force_stage": 5,
//                     "force_lang": "ru", "force_in_group": false }
// Dry run:     POST { "dry_run": true }
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

// Tribute preselects the longest period on its checkout page, so every pay link
// carries a short reminder to pick the period first.
const PERIOD_NOTE_RU = "Обратите внимание: период подписки (1, 3, 6 или 12 месяцев) выбирается на странице оплаты Tribute. По умолчанию там отмечен вариант на 12 месяцев, поэтому перед оплатой выберите нужный вам срок.";
const PERIOD_NOTE_EN = "Please note: you choose the subscription period (1, 3, 6 or 12 months) on the Tribute checkout page. The 12-month option is preselected there, so pick the period you want before paying.";

// Reissues a fresh 24-hour single-use group link via the bot.
const GROUP_INVITE_URL = "https://t.me/belfedbot?start=invite";
// Sends the user into the asset-request flow.
const REQUEST_URL = "https://t.me/belfedbot?start=request";

// Public track record (no paywall). RU has one combined page, EN does not.
const STATS_LINK_RU = "https://belfed.ru/ru/results.html";
const STATS_LINK_EN = "https://belfed.com/trades.html";
const STATS_LINK_EN2 = "https://belfed.com/equities-trades.html";

const SENT_COL: Record<number, string> = {
  5: "trial_rem_d5_sent_at",
  3: "trial_rem_d3_sent_at",
  1: "trial_rem_d1_sent_at",
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Lang = "ru" | "en";
type Btn = { text: string; url: string };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function isBlocked(err?: string) {
  return !!err && /blocked|forbidden|chat not found|deactivated|user is deactivated/i.test(err);
}

async function sendTg(
  chatId: number | string,
  text: string,
  buttons: Btn[] = [],
): Promise<{ ok: boolean; error?: string; blocked: boolean }> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
  };
  if (buttons.length) {
    payload.reply_markup = { inline_keyboard: buttons.map((b) => [{ text: b.text, url: b.url }]) };
  }
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({ ok: false }));
  if (!j.ok) {
    const err = j.description || "tg error";
    return { ok: false, error: err, blocked: isBlocked(err) };
  }
  return { ok: true, blocked: false };
}

function fmtDate(iso: string, lang: Lang): string {
  return new Date(iso).toLocaleDateString(lang === "en" ? "en-US" : "ru-RU", {
    day: lang === "en" ? "numeric" : "2-digit",
    month: "long",
  });
}

// ─── Message texts ───────────────────────────────────────────────

type Msg = { text: string; buttons: Btn[] };

const BULLETS_EN =
  "\u2022 30% lifetime discount off the current price, which is *$10.50/mo*\n" +
  "\u2022 One asset-analysis request with priority processing\n" +
  "\u2022 Founding Member status tied to your account: if you ever need to pause, you have up to 30 days to come back without losing your discount or status";
const BULLETS_RU =
  "\u2022 Пожизненная скидка 30% от действующего прайс-листа, сегодня это *1 050 ₽/мес* вместо 1 500 ₽\n" +
  "\u2022 Один запрос на анализ актива с приоритетной обработкой\n" +
  "\u2022 Статус Founding Member закреплён за аккаунтом: при необходимости паузы у вас есть до 30 дней, чтобы вернуться без потери скидки и статуса";

const FM_BTN: Record<Lang, string> = {
  ru: "⭐ Перейти на Founding Member",
  en: "⭐ Become a Founding Member",
};
const JOIN_BTN: Record<Lang, string> = {
  ru: "🔓 Получить ссылку в группу",
  en: "🔓 Get my group link",
};
const ASK_BTN: Record<Lang, string> = {
  ru: "📊 Запросить разбор актива",
  en: "📊 Request an asset breakdown",
};

// What the person is missing while they stay outside the group.
const INSIDE_RU =
  "\u2022 технические разборы активов с уровнями и сценариями\n" +
  "\u2022 оповещения о наших торговых сделках: вход, стоп, цели\n" +
  "\u2022 Лента с оперативным пульсом рынка, около 25 записей в неделю";
const INSIDE_EN =
  "\u2022 technical asset breakdowns with levels and scenarios\n" +
  "\u2022 alerts on our trades: entry, stop, targets\n" +
  "\u2022 the Feed with the operational pulse of the market, around 25 entries a week";

// ─── Branch A: the person never entered the closed group ─────────
// No payment pitch before the last day. Someone who has seen nothing has no
// reason to pay, and asking makes the offer look cheap.

function msgOutside(stage: number, lang: Lang, ends: string): Msg {
  if (lang === "en") {
    if (stage === 1) {
      return {
        text:
          "🔔 Your BelFed trial ends *tomorrow* (" + ends + "), and you have not entered the private group yet.\n\n" +
          "That is where the service actually lives:\n\n" + INSIDE_EN +
          "\n\nThere is still time today. Tap the first button, look around, and then decide.\n\n" +
          "If you choose to stay, the Founding Member terms are:\n\n" + BULLETS_EN,
        buttons: [
          { text: JOIN_BTN[lang], url: GROUP_INVITE_URL },
          { text: FM_BTN[lang], url: FM_LINK_EN },
        ],
      };
    }
    const days = stage === 5 ? "5 days" : "3 days";
    return {
      text:
        "⏳ Your BelFed trial ends on *" + ends + "*, in " + days + ".\n\n" +
        "You have not entered the private group yet, and that is where almost everything happens:\n\n" + INSIDE_EN +
        "\n\nThe invite link is single-use and lives 24 hours, so if the old one no longer opens, tap below for a fresh one.",
      buttons: [{ text: JOIN_BTN[lang], url: GROUP_INVITE_URL }],
    };
  }
  if (stage === 1) {
    return {
      text:
        "🔔 Ваш пробный доступ заканчивается *завтра* (" + ends + "), а в закрытую группу вы так и не заходили.\n\n" +
        "Именно там происходит основное:\n\n" + INSIDE_RU +
        "\n\nСегодня ещё есть время. Нажмите первую кнопку, посмотрите изнутри, и уже потом решайте.\n\n" +
        "Если решите остаться, условия со-основателя:\n\n" + BULLETS_RU,
      buttons: [
        { text: JOIN_BTN[lang], url: GROUP_INVITE_URL },
        { text: FM_BTN[lang], url: FM_LINK_RU },
      ],
    };
  }
  const days = stage === 5 ? "5 дней" : "3 дня";
  return {
    text:
      "⏳ Ваш пробный доступ к BelFed заканчивается *" + ends + "*, через " + days + ".\n\n" +
      "В закрытую группу вы пока не заходили, а там происходит почти всё:\n\n" + INSIDE_RU +
      "\n\nСсылка одноразовая и живёт 24 часа, поэтому если прежняя уже не открывается, нажмите кнопку ниже и получите новую.",
    buttons: [{ text: JOIN_BTN[lang], url: GROUP_INVITE_URL }],
  };
}

// ─── Branch B: the person is inside the group ────────────────────

function msgInside(stage: number, lang: Lang, ends: string, everRequested: boolean): Msg {
  const askLine = everRequested
    ? ""
    : (lang === "en"
      ? "\n\nOne thing you have not used yet: a personal asset breakdown. Send a ticker and we will do it, median turnaround around 3 hours."
      : "\n\nОдно вы ещё не пробовали: персональный разбор актива. Пришлите тикер, и мы его сделаем, медианное время около 3 часов.");

  const askBtn: Btn[] = everRequested ? [] : [{ text: ASK_BTN[lang], url: REQUEST_URL }];

  if (lang === "en") {
    if (stage === 5) {
      return {
        text:
          "⏳ Your BelFed trial ends on *" + ends + "* (in 5 days).\n\n" +
          "As a thank-you to our earliest subscribers, we have opened 50 exclusive Founding Member seats:\n\n" +
          BULLETS_EN + askLine,
        buttons: [{ text: FM_BTN[lang], url: FM_LINK_EN }, ...askBtn],
      };
    }
    if (stage === 3) {
      return {
        text:
          "📌 Your BelFed trial ends on *" + ends + "* (in 3 days).\n\n" +
          "What Founding Members lock in for good:\n\n" + BULLETS_EN + askLine +
          "\n\nOnly 50 seats, and they are going fast.",
        buttons: [{ text: FM_BTN[lang], url: FM_LINK_EN }, ...askBtn],
      };
    }
    return {
      text:
        "🔔 Your BelFed trial ends *tomorrow* (" + ends + "). Access to analytics and trading opportunities closes after that.\n\n" +
        "Last chance to lock in Founding Member terms:\n\n" + BULLETS_EN +
        `\n\n📊 Track record: [crypto and commodities](${STATS_LINK_EN}) and [equities](${STATS_LINK_EN2})`,
      buttons: [{ text: FM_BTN[lang], url: FM_LINK_EN }],
    };
  }

  if (stage === 5) {
    return {
      text:
        "⏳ Ваш пробный доступ к BelFed заканчивается *" + ends + "* (через 5 дней).\n\n" +
        "В знак благодарности нашим первым подписчикам мы выделили 50 эксклюзивных мест на условиях Founding Member (со-основатели сервиса):\n\n" +
        BULLETS_RU + askLine,
      buttons: [{ text: FM_BTN[lang], url: FM_LINK_RU }, ...askBtn],
    };
  }
  if (stage === 3) {
    return {
      text:
        "📌 Ваш пробный доступ к BelFed заканчивается *" + ends + "* (через 3 дня).\n\n" +
        "Что со-основатели закрепляют за собой навсегда:\n\n" + BULLETS_RU + askLine +
        "\n\nМест немного, 50 на всех. Успейте занять своё.",
      buttons: [{ text: FM_BTN[lang], url: FM_LINK_RU }, ...askBtn],
    };
  }
  return {
    text:
      "🔔 Ваш пробный доступ к BelFed заканчивается *завтра* (" + ends + "). После этого доступ к аналитике и *торговым возможностям* закроется.\n\n" +
      "Последняя возможность зафиксировать условия Founding Member:\n\n" + BULLETS_RU +
      `\n\n📊 [Статистика наших сделок по всем направлениям →](${STATS_LINK_RU})`,
    buttons: [{ text: FM_BTN[lang], url: FM_LINK_RU }],
  };
}

// Adds the period reminder to messages that carry a Tribute checkout button.
function withPeriodNote(m: Msg, lang: Lang): Msg {
  if (!m.buttons.some((b) => b.url === FM_LINK_RU || b.url === FM_LINK_EN)) return m;
  return { ...m, text: m.text + "\n\n" + (lang === "en" ? PERIOD_NOTE_EN : PERIOD_NOTE_RU) };
}

function buildMsg(stage: number, lang: Lang, ends: string, inGroup: boolean, everRequested: boolean): Msg {
  const m = inGroup ? msgInside(stage, lang, ends, everRequested) : msgOutside(stage, lang, ends);
  return withPeriodNote(m, lang);
}

// ─── Main handler ───────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({})) as Record<string, unknown>;

  const forceTgId = body.force_telegram_id != null ? String(body.force_telegram_id) : null;
  const forceStage = typeof body.force_stage === "number" ? body.force_stage as 5 | 3 | 1 : null;
  const forceLang = typeof body.force_lang === "string" && ["ru", "en"].includes(body.force_lang)
    ? body.force_lang as Lang : null;
  const dryRun = body.dry_run === true;
  const previewOnly = body.preview_only === true;

  if (previewOnly) {
    const lang = forceLang ?? "ru";
    const ends = fmtDate(new Date(Date.now() + 3 * 86400000).toISOString(), lang);
    const out: Record<string, unknown> = {};
    for (const stage of [5, 3, 1]) {
      for (const inGroup of [true, false]) {
        const m = buildMsg(stage, lang, ends, inGroup, false);
        out[`d${stage}_${inGroup ? "inside" : "outside"}`] = { text: m.text, buttons: m.buttons.map((b) => b.text) };
      }
    }
    return json({ ok: true, preview: true, lang, messages: out });
  }

  // Manual test path: never stamps.
  if (forceTgId && forceStage) {
    const lang = forceLang ?? "ru";
    const inGroup = body.force_in_group !== false;
    const ends = fmtDate(new Date(Date.now() + forceStage * 86400000).toISOString(), lang);
    const m = buildMsg(forceStage, lang, ends, inGroup, body.force_ever_requested === true);
    const res = await sendTg(forceTgId, m.text, m.buttons);
    return json({ ok: res.ok, stage: forceStage, lang, in_group: inGroup, error: res.error });
  }

  const { data: list, error } = await admin
    .from("users_for_trial_reminder_staged")
    .select("user_id, telegram_id, lang, trial_end, stage, in_group, ever_requested")
    .limit(500);
  if (error) return json({ error: error.message }, 500);

  if (dryRun) {
    const agg: Record<string, number> = {};
    for (const row of list ?? []) {
      const k = `d${row.stage}_${row.in_group ? "inside" : "outside"}_${row.lang === "en" ? "en" : "ru"}`;
      agg[k] = (agg[k] || 0) + 1;
    }
    return json({ ok: true, dry_run: true, considered: (list ?? []).length, breakdown: agg });
  }

  const results: Array<Record<string, unknown>> = [];
  for (const row of list ?? []) {
    const lang: Lang = row.lang === "en" ? "en" : "ru";
    const ends = fmtDate(row.trial_end as string, lang);
    const stage = Number(row.stage);
    const m = buildMsg(stage, lang, ends, row.in_group === true, row.ever_requested === true);
    const res = await sendTg(row.telegram_id as string, m.text, m.buttons);
    // Stamp on success and on a hard block. Only a transient error stays
    // unstamped, so the next daily run retries it once more.
    if (res.ok || res.blocked) {
      await admin.from("profiles")
        .update({ [SENT_COL[stage]]: new Date().toISOString() })
        .eq("id", row.user_id as string);
    }
    results.push({
      stage,
      user: row.user_id,
      lang,
      in_group: row.in_group === true,
      status: res.ok ? "sent" : (res.blocked ? "blocked" : "error"),
      error: res.ok ? undefined : res.error,
    });
  }

  return json({
    ok: true,
    considered: results.length,
    sent: results.filter((r) => r.status === "sent").length,
    blocked: results.filter((r) => r.status === "blocked").length,
    errors: results.filter((r) => r.status === "error").length,
  });
});
