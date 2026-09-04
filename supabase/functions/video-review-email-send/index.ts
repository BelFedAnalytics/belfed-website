// video-review-email-send
// Manual, admin-only announcement for a published Video Review.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") || "";
const FROM_EMAIL = "noreply@belfed.com";
const FROM_NAME = "BelFed Analytics";
const REPLY_TO = "contact@belfed.com";
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
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isSendableEmail(value: unknown): boolean {
  const email = String(value || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return false;
  const domain = email.split("@")[1] || "";
  if (!domain.includes(".")) return false;
  return !["belfed.local", "localhost", "example.com", "test"]
    .some((blocked) => domain === blocked || domain.endsWith(`.${blocked}`));
}

function unsubscribePage(lang: "ru" | "en", token: string): string {
  const site = lang === "en" ? "https://belfed.com" : "https://belfed.ru";
  return `${site}/unsubscribe.html?token=${encodeURIComponent(token)}`;
}

function unsubscribeApi(token: string): string {
  return `${SUPABASE_URL}/functions/v1/email-unsubscribe?token=${encodeURIComponent(token)}`;
}

function renderEmail(review: any, lang: "ru" | "en", token: string) {
  const isEn = lang === "en";
  const fallback = lang === "en" ? "ru" : "en";
  const complete = (candidate: "ru" | "en") =>
    !!review[`title_${candidate}`] && !!review[`video_url_${candidate}`];
  const contentLang = complete(lang) ? lang : fallback;
  const title = review[`title_${contentLang}`];
  const summary = review[`summary_${contentLang}`] || "";
  const site = isEn ? "https://belfed.com" : "https://belfed.ru";
  const reviewUrl = `${site}/analytics.html?tab=videos&video=${encodeURIComponent(review.slug)}`;
  const preferencesUrl = `${site}/members.html#email`;
  const unsubscribeUrl = unsubscribePage(lang, token);
  const subject = isEn
    ? `New video review: ${title}`
    : `Новый видеообзор: ${title}`;
  const preheader = isEn
    ? "A new sector review is available in your BelFed account."
    : "Новый обзор сектора уже доступен в кабинете BelFed.";
  const intro = isEn ? "A new video review is now available" : "Вышел новый видеообзор";
  const cta = isEn ? "WATCH IN YOUR ACCOUNT" : "СМОТРЕТЬ В КАБИНЕТЕ";
  const settings = isEn ? "Email preferences" : "Настройки писем";
  const unsubscribe = isEn ? "Unsubscribe from all emails" : "Отписаться от всех писем";
  const reason = isEn
    ? "You are receiving this because Video Review notifications are enabled in your BelFed account."
    : "Вы получили это письмо, потому что включили уведомления о видеообзорах в кабинете BelFed.";
  const summaryHtml = summary
    ? `<p style="margin:0 0 24px;color:#37342d;font-size:15px;line-height:1.7">${escapeHtml(summary).replaceAll("\n", "<br>")}</p>`
    : "";

  const html = `<!doctype html>
<html><body style="margin:0;background:#f5f2eb;color:#111;font-family:Arial,Helvetica,sans-serif">
<div style="display:none;max-height:0;overflow:hidden">${escapeHtml(preheader)}</div>
<div style="max-width:620px;margin:0 auto;padding:32px 18px">
  <div style="background:#fff;border:1px solid #111;padding:30px">
    <div style="font:700 12px/1.2 'Courier New',monospace;letter-spacing:2px;margin-bottom:28px">BELFED ANALYTICS</div>
    <div style="font:12px/1.4 'Courier New',monospace;letter-spacing:1.5px;color:#777;text-transform:uppercase;margin-bottom:10px">${escapeHtml(intro)}</div>
    <h1 style="margin:0 0 18px;font-size:28px;line-height:1.2">${escapeHtml(title)}</h1>
    ${summaryHtml}
    <a href="${reviewUrl}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:14px 20px;font:700 12px/1 'Courier New',monospace;letter-spacing:1.5px">${cta}</a>
    <div style="margin-top:30px;padding-top:18px;border-top:1px dashed #bbb;color:#777;font-size:12px;line-height:1.7">
      ${escapeHtml(reason)}<br>
      <a href="${preferencesUrl}" style="color:#555">${settings}</a> ·
      <a href="${unsubscribeUrl}" style="color:#555">${unsubscribe}</a>
    </div>
  </div>
</div></body></html>`;

  return { subject, html };
}

async function sendBrevo(
  subscriber: any,
  review: any,
  idempotencyKey: string,
): Promise<{ ok: true; messageId: string } | { ok: false; error: string; uncertain?: boolean }> {
  if (!BREVO_API_KEY) return { ok: false, error: "BREVO_API_KEY is not configured" };
  const lang: "ru" | "en" = subscriber.language === "en" ? "en" : "ru";
  const token = String(subscriber.unsubscribe_token);
  const rendered = renderEmail(review, lang, token);
  const payload = JSON.stringify({
    sender: { email: FROM_EMAIL, name: FROM_NAME },
    replyTo: { email: REPLY_TO, name: FROM_NAME },
    to: [{ email: subscriber.email }],
    subject: rendered.subject,
    htmlContent: rendered.html,
    tags: [`video-review-${String(review.id).slice(0, 8)}`],
    headers: {
      "idempotencyKey": idempotencyKey,
      "List-Unsubscribe": `<${unsubscribeApi(token)}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "accept": "application/json",
          "api-key": BREVO_API_KEY,
          "content-type": "application/json",
        },
        body: payload,
      });
      if (response.ok) {
        const result = await response.json().catch(() => ({}));
        return { ok: true, messageId: result.messageId || result.message_id || "" };
      }
      const text = (await response.text().catch(() => "")).slice(0, 500);
      if (response.status !== 429 && response.status < 500) {
        return { ok: false, error: `brevo ${response.status}: ${text}` };
      }
      if (attempt === 2) return { ok: false, error: `brevo ${response.status}: ${text}` };
      const retryAfter = Number(response.headers.get("retry-after"));
      await new Promise((resolve) =>
        setTimeout(resolve, Number.isFinite(retryAfter) ? retryAfter * 1000 : 500 * 2 ** attempt)
      );
    } catch (error) {
      // A network failure is ambiguous: Brevo may have accepted the message
      // before the connection broke. Keep the audit row queued so a retry
      // cannot silently duplicate delivery.
      return { ok: false, error: `network: ${String(error)}`, uncertain: true };
    }
  }
  return { ok: false, error: "brevo retry exhausted" };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, origin);

  try {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ error: "unauthorized" }, 401, origin);
    const { data: userData, error: userError } = await db.auth.getUser(jwt);
    if (userError || !userData.user) return json({ error: "invalid_jwt" }, 401, origin);

    const { data: adminProfile, error: adminError } = await db
      .from("profiles")
      .select("subscription_status")
      .eq("id", userData.user.id)
      .maybeSingle();
    if (adminError) return json({ error: adminError.message }, 500, origin);
    if (adminProfile?.subscription_status !== "admin") {
      return json({ error: "forbidden" }, 403, origin);
    }

    const body = await req.json().catch(() => ({}));
    const reviewId = typeof body.video_review_id === "string" ? body.video_review_id : "";
    if (!reviewId) return json({ error: "video_review_id required" }, 400, origin);

    const { data: review, error: reviewError } = await db
      .from("video_reviews")
      .select("id, slug, status, title_ru, title_en, summary_ru, summary_en, video_url_ru, video_url_en, email_sent_at")
      .eq("id", reviewId)
      .single();
    if (reviewError || !review) return json({ error: "video review not found" }, 404, origin);
    if (review.status !== "published") return json({ error: "video review is not published" }, 409, origin);
    if (review.email_sent_at) {
      return json({ ok: true, sent: 0, skipped: 0, failed: 0, note: "already sent" }, 200, origin);
    }
    const { data: claimed, error: claimError } = await db
      .rpc("claim_video_review_email_send", { p_review_id: reviewId });
    if (claimError) return json({ error: claimError.message }, 500, origin);
    if (claimed !== true) {
      return json({ error: "email campaign is already running or completed" }, 409, origin);
    }

    const { data: subscribers, error: recipientsError } = await db
      .rpc("video_review_email_recipients");
    if (recipientsError) {
      await db.from("video_reviews").update({ email_send_started_at: null }).eq("id", reviewId);
      return json({ error: recipientsError.message }, 500, origin);
    }

    const { data: already, error: alreadyError } = await db
      .from("email_sends")
      .select("id, subscriber_id, status")
      .eq("video_review_id", reviewId);
    if (alreadyError) {
      await db.from("video_reviews").update({ email_send_started_at: null }).eq("id", reviewId);
      return json({ error: alreadyError.message }, 500, origin);
    }
    const existingBySubscriber = new Map(
      (already || []).map((row: any) => [row.subscriber_id, row]),
    );
    const targets = (subscribers || []).filter((sub: any) => isSendableEmail(sub.email));
    const uncertain = targets.filter((sub: any) =>
      existingBySubscriber.get(sub.subscriber_id)?.status === "queued"
    ).length;
    if (uncertain > 0) {
      await db.from("video_reviews").update({ email_send_started_at: null }).eq("id", reviewId);
      return json({
        error: "queued deliveries require manual reconciliation before retry",
        queued: uncertain,
      }, 409, origin);
    }
    const jobs: Array<{ subscriber: any; logId: string }> = [];
    let skipped = (subscribers?.length || 0) - targets.length;
    for (const subscriber of targets) {
      const existing = existingBySubscriber.get(subscriber.subscriber_id) as any;
      if (existing && existing.status !== "failed") {
        skipped++;
        continue;
      }
      const baseLog = {
        video_review_id: reviewId,
        subscriber_id: subscriber.subscriber_id,
        email: subscriber.email,
        language: subscriber.language === "en" ? "en" : "ru",
        segment: subscriber.segment,
        status: "queued",
        error: null,
      };
      const query = existing
        ? db.from("email_sends").update(baseLog).eq("id", existing.id).select("id").single()
        : db.from("email_sends").insert(baseLog).select("id").single();
      const { data: claimedLog, error: logClaimError } = await query;
      if (logClaimError || !claimedLog) {
        await db.from("video_reviews").update({ email_send_started_at: null }).eq("id", reviewId);
        return json({ error: `recipient claim failed: ${logClaimError?.message || "missing row"}` }, 500, origin);
      }
      jobs.push({ subscriber, logId: claimedLog.id });
    }

    let sent = 0;
    let failed = 0;
    const errors: Array<{ email: string; error: string }> = [];
    let cursor = 0;
    const worker = async () => {
      while (cursor < jobs.length) {
        const { subscriber, logId } = jobs[cursor++];
        try {
          const result = await sendBrevo(subscriber, review, logId);
          const patch: any = {
            status: result.ok ? "sent" : result.uncertain ? "queued" : "failed",
            error: result.ok ? null : result.error.slice(0, 1000),
          };
          if (result.ok) {
            patch.brevo_message_id = result.messageId || null;
            patch.sent_at = new Date().toISOString();
          }
          const { error: logError } = await db
            .from("email_sends")
            .update(patch)
            .eq("id", logId);
          if (logError) {
            failed++;
            errors.push({ email: subscriber.email, error: `audit: ${logError.message}` });
          } else if (result.ok) {
            sent++;
          } else {
            failed++;
            errors.push({ email: subscriber.email, error: result.error });
          }
        } catch (error) {
          failed++;
          errors.push({ email: subscriber.email, error: String(error) });
          await db.from("email_sends").update({
            status: "queued",
            error: String(error).slice(0, 1000),
          }).eq("id", logId);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(5, jobs.length) }, () => worker()),
    );

    if (failed === 0) {
      const { error: finalizeError } = await db
        .from("video_reviews")
        .update({ email_sent_at: new Date().toISOString(), email_send_started_at: null })
        .eq("id", reviewId);
      if (finalizeError) {
        return json({ error: `campaign finalize failed: ${finalizeError.message}` }, 500, origin);
      }
    } else {
      const { error: releaseError } = await db
        .from("video_reviews")
        .update({ email_send_started_at: null })
        .eq("id", reviewId);
      if (releaseError) errors.push({ email: "", error: `claim release: ${releaseError.message}` });
    }

    return json({
      ok: failed === 0,
      total: subscribers?.length || 0,
      targets: jobs.length,
      sent,
      failed,
      skipped,
      error: failed > 0 ? "some deliveries failed or require reconciliation" : undefined,
      errors: errors.slice(0, 10),
    }, failed === 0 ? 200 : 502, origin);
  } catch (error) {
    return json({ error: String(error) }, 500, origin);
  }
});
