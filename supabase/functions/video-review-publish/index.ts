// video-review-publish
// Admin-only, idempotent Telegram delivery for selected Video Review locales.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";
const SITE_BASE_RU = Deno.env.get("SITE_BASE_RU") ?? "https://belfed.ru";
const SITE_BASE_EN = Deno.env.get("SITE_BASE_EN") ?? "https://belfed.com";
const ALLOWED_ORIGINS = new Set([
  "https://belfed.ru",
  "https://www.belfed.ru",
  "https://belfed.com",
  "https://www.belfed.com",
]);

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function cors(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://belfed.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Vary": "Origin",
  };
}

function json(data: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors(origin), "Content-Type": "application/json" },
  });
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeHttps(value: unknown): string {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function safeThumbnail(value: unknown): string {
  const safe = safeHttps(value);
  if (!safe) return "";
  const host = new URL(safe).hostname.toLowerCase();
  const allowed = host === "obujqvqqmyfcfflhqvud.supabase.co"
    || host === "i.ytimg.com"
    || host === "img.youtube.com";
  return allowed ? safe : "";
}

function truncate(value: unknown, max: number): string {
  const text = String(value ?? "").trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function caption(review: any, lang: "ru" | "en"): string {
  const title = escapeHtml(truncate(review[`title_${lang}`], 180));
  const summary = escapeHtml(truncate(review[`summary_${lang}`], 650));
  const date = escapeHtml(review.review_date || "");
  const sector = escapeHtml(truncate(review.sector, 80));
  const heading = lang === "en" ? "BELFED VIDEO REVIEW" : "ВИДЕООБЗОР BELFED";
  const meta = [date, sector].filter(Boolean).join(" · ");
  const lines = [`// ${heading}${meta ? ` · ${meta}` : ""}`, "", `<b>${title}</b>`];
  if (summary) lines.push("", summary);
  return lines.join("\n");
}

function replyMarkup(review: any, lang: "ru" | "en") {
  const siteEnabled = !!review[`publish_to_site_${lang}`];
  const site = lang === "en" ? SITE_BASE_EN : SITE_BASE_RU;
  const videoUrl = safeHttps(review[`video_url_${lang}`]);
  const buttons: Array<{ text: string; url: string }> = [];
  if (videoUrl) {
    buttons.push({ text: lang === "en" ? "WATCH VIDEO" : "СМОТРЕТЬ ВИДЕО", url: videoUrl });
  }
  if (siteEnabled) {
    buttons.push({
      text: lang === "en" ? "OPEN IN BELFED" : "ОТКРЫТЬ В BELFED",
      url: `${site}/analytics.html?tab=videos&video=${encodeURIComponent(review.slug)}`,
    });
  }
  return buttons.length ? { inline_keyboard: [buttons] } : undefined;
}

type TelegramMethod =
  | "sendPhoto"
  | "sendMessage"
  | "editMessageMedia"
  | "editMessageCaption"
  | "editMessageText";

async function telegram(method: TelegramMethod, payload: Record<string, unknown>): Promise<any> {
  if (!TELEGRAM_BOT_TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN is not configured", uncertain: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      let parsed = true;
      const body = await response.json().catch(() => {
        parsed = false;
        return null;
      });
      if (response.ok && parsed && body?.ok === true && body?.result?.message_id) {
        return { ok: true, message: body.result };
      }
      if (response.status === 429 && attempt < 2) {
        const delay = Math.min(Number(body?.parameters?.retry_after || 1) * 1000 + 200, 10_000);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      return {
        ok: false,
        status: response.status,
        error: `telegram ${response.status}: ${String(body?.description || "request failed")}`,
        uncertain: response.status >= 500
          || (response.ok && !(parsed && body?.ok === false)),
      };
    } catch (error) {
      return { ok: false, error: `telegram network: ${String(error)}`, uncertain: true };
    }
  }
  return { ok: false, error: "telegram retry exhausted", uncertain: false };
}

async function finishAttempt(
  attemptId: string,
  status: "sent" | "uncertain" | "failed",
  result: Record<string, unknown> | null,
  error: string | null,
) {
  const { data, error: finishError } = await db.rpc(
    "finish_video_review_telegram_attempt",
    {
      p_attempt_id: attemptId,
      p_status: status,
      p_result: result,
      p_error: error,
    },
  );
  if (finishError || data !== true) {
    return { ok: false, error: finishError?.message || "attempt finalization failed" };
  }
  return { ok: true };
}

async function publishAttempt(claim: any, lang: "ru" | "en") {
  const attemptId = typeof claim?.attempt_id === "string" ? claim.attempt_id : "";
  const review = claim?.snapshot;
  if (!attemptId || !review || typeof review !== "object") {
    return { error: "invalid durable Telegram attempt", uncertain: true };
  }
  const previous = review.previous_state;
  const topic = {
    chat_id: review.topic_chat_id,
    thread_id: review.topic_thread_id,
  };

  const common: Record<string, unknown> = {
    chat_id: topic.chat_id,
    reply_markup: replyMarkup(review, lang),
  };
  const sendCommon = { ...common, message_thread_id: topic.thread_id };
  const image = safeThumbnail(review[`thumbnail_url_${lang}`]);
  let method: "sendPhoto" | "sendMessage" = image ? "sendPhoto" : "sendMessage";
  let result;
  if (previous?.message_id) {
    method = previous.method || (previous.photo ? "sendPhoto" : "sendMessage");
    if (method === "sendPhoto" && image) {
      result = await telegram("editMessageMedia", {
        ...common,
        message_id: previous.message_id,
        media: { type: "photo", media: image, caption: caption(review, lang), parse_mode: "HTML" },
      });
    } else if (method === "sendPhoto") {
      const error = "cannot remove the cover from an existing Telegram photo post; keep the cover or reconcile manually";
      const finalized = await finishAttempt(attemptId, "failed", null, error);
      return finalized.ok
        ? { error, attempt_id: attemptId }
        : { error: `${error}; durable attempt ${attemptId} finalization failed: ${finalized.error}`, attempt_id: attemptId, uncertain: true };
    } else if (!image) {
      result = await telegram("editMessageText", {
        ...common,
        message_id: previous.message_id,
        text: caption(review, lang),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } else {
      const error = "cannot add a cover to an existing text-only Telegram post; publish a new review or reconcile manually";
      const finalized = await finishAttempt(attemptId, "failed", null, error);
      return finalized.ok
        ? { error, attempt_id: attemptId }
        : { error: `${error}; durable attempt ${attemptId} finalization failed: ${finalized.error}`, attempt_id: attemptId, uncertain: true };
    }
  } else {
    result = image
      ? await telegram("sendPhoto", { ...sendCommon, photo: image, caption: caption(review, lang), parse_mode: "HTML" })
      : await telegram("sendMessage", {
          ...sendCommon,
          text: caption(review, lang),
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
    if (image && !result.ok && result.status === 400 && !result.uncertain) {
      method = "sendMessage";
      result = await telegram("sendMessage", {
        ...sendCommon,
        text: caption(review, lang),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    }
  }

  if (!result.ok) {
    const status = result.uncertain ? "uncertain" : "failed";
    const telegramResult = {
      status: result.status || null,
      method,
      chat_id: topic.chat_id,
      thread_id: topic.thread_id,
      message_id: result.message?.message_id || previous?.message_id || null,
    };
    const finalized = await finishAttempt(attemptId, status, telegramResult, result.error);
    if (!finalized.ok) {
      return {
        error: `${result.error}; durable attempt ${attemptId} finalization failed: ${finalized.error}`,
        attempt_id: attemptId,
        uncertain: true,
        telegram_result: telegramResult,
      };
    }
    return { error: result.error, uncertain: !!result.uncertain, attempt_id: attemptId };
  }

  const record = {
    status: "sent",
    chat_id: topic.chat_id,
    thread_id: topic.thread_id,
    message_id: result.message?.message_id || previous?.message_id,
    method,
    photo: image || previous?.photo || null,
    sent_at: new Date().toISOString(),
    updated: !!previous?.message_id,
    attempt_id: attemptId,
  };
  const finalized = await finishAttempt(attemptId, "sent", record, null);
  if (!finalized.ok) {
    return {
      error: `telegram sent but durable attempt ${attemptId} finalization failed: ${finalized.error}`,
      uncertain: true,
      attempt_id: attemptId,
      telegram_result: record,
    };
  }
  return record;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401, origin);
    const { data: userData, error: userError } = await db.auth.getUser(jwt);
    if (userError || !userData.user) return json({ error: "invalid_jwt" }, 401, origin);
    const { data: profile, error: profileError } = await db
      .from("profiles")
      .select("subscription_status")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (profileError) return json({ error: profileError.message }, 500, origin);
    if (profile?.subscription_status !== "admin") return json({ error: "forbidden" }, 403, origin);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_body" }, 400, origin);
    }
    const reviewId = typeof body.video_review_id === "string" ? body.video_review_id : "";
    const expectedUpdatedAt = typeof body.expected_updated_at === "string" ? body.expected_updated_at : "";
    const operationId = typeof body.operation_id === "string" ? body.operation_id : "";
    const langs = Array.isArray(body.languages)
      ? [...new Set(body.languages.filter((lang: unknown) => lang === "ru" || lang === "en"))]
      : [];
    if (!reviewId || !expectedUpdatedAt || !operationId || !langs.length) {
      return json(
        { error: "video_review_id, languages, expected_updated_at and operation_id required" },
        400,
        origin,
      );
    }

    const { data: claims, error: claimError } = await db.rpc(
      "claim_video_review_telegram_publish",
      {
        p_review_id: reviewId,
        p_langs: langs,
        p_expected_updated_at: expectedUpdatedAt,
        p_operation_id: operationId,
      },
    );
    if (claimError || !claims) {
      return json({ error: claimError?.message || "Telegram publication could not be claimed" }, 409, origin);
    }

    const results: Record<string, unknown> = {};
    for (const lang of langs as Array<"ru" | "en">) {
      results[lang] = await publishAttempt(claims[lang], lang);
    }
    const failed = Object.values(results).some((value: any) => value?.error);
    return json({ ok: !failed, results }, failed ? 502 : 200, origin);
  } catch (error) {
    return json({ error: String(error) }, 500, origin);
  }
});
