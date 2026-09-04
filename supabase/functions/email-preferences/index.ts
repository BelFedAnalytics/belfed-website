// email-preferences
// Manages a member's email-notification preferences.
//
// GET  → returns current subscription state and all per-event flags
// POST → { enabled?, language?, notify_analytics?, notify_video_reviews?, notify_position_open?,
//          notify_stop_hit?, notify_take_profit?, notify_manual_close?, test? }
//
// Segment is determined by `user_has_access(uid)` RPC, so admins, active
// subscribers and trial users all map to the same 'premium' segment.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") || "";
const FROM_EMAIL = "noreply@belfed.com";
const FROM_NAME = "BelFed Analytics";
const REPLY_TO = "contact@belfed.com";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function syncBrevoBlacklist(email: string, blacklisted: boolean) {
  if (!BREVO_API_KEY) return { ok: false, error: "brevo_not_configured" };
  try {
    const response = await fetch("https://api.brevo.com/v3/contacts", {
      method: "POST",
      headers: {
        "accept": "application/json",
        "api-key": BREVO_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        email: email.trim().toLowerCase(),
        emailBlacklisted: blacklisted,
        updateEnabled: true,
      }),
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `brevo ${response.status}: ${(await response.text().catch(() => "")).slice(0, 300)}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: `brevo network: ${String(error)}` };
  }
}

const EVENT_FLAGS = [
  "notify_analytics",
  "notify_video_reviews",
  "notify_position_open",
  "notify_stop_hit",
  "notify_take_profit",
  "notify_manual_close",
] as const;

type EventFlag = (typeof EVENT_FLAGS)[number];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "invalid_jwt" }, 401);
  const userId = userData.user.id;

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, email, lang, subscription_status, email_opt_out")
    .eq("id", userId)
    .maybeSingle();

  if (profileError) return json({ error: profileError.message }, 500);
  if (!profile || !profile.email) return json({ error: "no_email" }, 400);

  // Determine entitlement via the same RPC used elsewhere so admin / active /
  // trial all map to 'premium' consistently.
  const { data: hasAccess, error: accessError } = await admin.rpc("user_has_access", {
    uid: userId,
  });
  if (accessError) return json({ error: accessError.message }, 500);
  const segment = hasAccess === true ? "premium" : "leads";

  if (req.method === "GET") {
    const { data: sub, error: subError } = await admin
      .from("email_subscribers")
      .select(
        "id, email, language, segment, unsubscribed_at, confirmed_at, source, notify_analytics, notify_video_reviews, notify_position_open, notify_stop_hit, notify_take_profit, notify_manual_close",
      )
      .eq("profile_id", userId)
      .eq("segment", segment)
      .maybeSingle();
    if (subError) return json({ error: subError.message }, 500);
    const enabled = !!sub && !sub.unsubscribed_at && !profile.email_opt_out;
    const flags: Record<string, boolean> = {};
    for (const f of EVENT_FLAGS) {
      flags[f] = sub ? !!sub[f] : f === "notify_video_reviews" ? false : true;
    }
    return json({
      ok: true,
      enabled,
      email: profile.email,
      segment,
      language: sub?.language || profile.lang || "ru",
      flags,
    });
  }

  if (req.method === "POST") {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid_json" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_body" }, 400);
    }

    // Test send mode — sends a sample BelFed email to the user's address.
    if (body && body.test === true) {
      if (!BREVO_API_KEY) return json({ error: "brevo_not_configured" }, 500);
      const { data: subForLang, error: langError } = await admin
        .from("email_subscribers")
        .select("language")
        .eq("profile_id", userId)
        .eq("segment", segment)
        .maybeSingle();
      if (langError) return json({ error: langError.message }, 500);
      const langRaw = subForLang?.language || profile.lang || "ru";
      const lang = (langRaw === "en" || langRaw === "ru") ? langRaw : "ru";
      const subject = lang === "ru"
        ? "BelFed: тестовое письмо"
        : "BelFed: test email";
      const greetingRu = `Здравствуйте,<br><br>Это тестовое письмо от BelFed Analytics. Если вы получили его — рассылка настроена корректно.<br><br>Реальные уведомления приходят в момент события: открытие позиции, срабатывание стопа, достижение целей, закрытие позиции, новые публикации аналитики.<br><br>Управлять подпиской: <a href=\"https://belfed.ru/members.html#email\">belfed.ru/members.html</a>`;
      const greetingEn = `Hello,<br><br>This is a test email from BelFed Analytics. If you've received it — the delivery pipeline is configured correctly.<br><br>Real notifications arrive as events happen: position opened, stop-loss hit, take-profit reached, manual close, new analytics publications.<br><br>Manage preferences: <a href=\"https://belfed.com/members.html#email\">belfed.com/members.html</a>`;
      const html = `<!DOCTYPE html><html><body style=\"font-family:Arial,Helvetica,sans-serif;color:#222;line-height:1.6;max-width:600px;margin:0 auto;padding:20px\"><div style=\"padding:20px;background:#faf6e8;border:1px solid #e0d8c5;border-radius:6px\"><h2 style=\"margin:0 0 14px 0;font-family:'Courier New',monospace;color:#1a1a1a\">// BelFed Analytics</h2><div>${lang === "ru" ? greetingRu : greetingEn}</div><p style=\"margin-top:24px;font-size:12px;color:#666;border-top:1px solid #e0d8c5;padding-top:14px\">noreply@belfed.com · contact@belfed.com</p></div></body></html>`;
      try {
        const r = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "accept": "application/json",
            "api-key": BREVO_API_KEY,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            sender: { email: FROM_EMAIL, name: FROM_NAME },
            replyTo: { email: REPLY_TO, name: FROM_NAME },
            to: [{ email: profile.email }],
            subject,
            htmlContent: html,
            tags: ["test"],
          }),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          return json({ error: `brevo ${r.status}: ${txt.slice(0, 300)}` }, 502);
        }
        const j2 = await r.json().catch(() => ({} as any));
        return json({ ok: true, test_sent_to: profile.email, message_id: j2.messageId || "" });
      } catch (e) {
        return json({ error: `network: ${(e as Error).message}` }, 502);
      }
    }

    // Build update payload. Any flag that is sent as a boolean will be applied.
    const flagUpdate: Record<string, boolean> = {};
    for (const f of EVENT_FLAGS) {
      if (typeof body[f] === "boolean") flagUpdate[f] = body[f];
    }
    const language =
      body.language === "ru" || body.language === "en" ? body.language : null;
    const hasEnabledField = typeof body.enabled === "boolean";

    const { data: existing, error: existingError } = await admin
      .from("email_subscribers")
      .select("id, unsubscribed_at")
      .eq("profile_id", userId)
      .eq("segment", segment)
      .maybeSingle();
    if (existingError) return json({ error: existingError.message }, 500);

    if (!existing) {
      const insertPayload: any = {
        email: profile.email.trim().toLowerCase(),
        language: language || profile.lang || "ru",
        segment,
        source: "auto_premium",
        profile_id: userId,
        confirmed_at: new Date().toISOString(),
        unsubscribed_at: hasEnabledField && body.enabled === false
          ? new Date().toISOString()
          : null,
        ...flagUpdate,
      };
      const { error } = await admin.from("email_subscribers").insert(
        insertPayload,
      );
      if (error) return json({ error: error.message }, 500);
    } else {
      const update: any = { ...flagUpdate, email: profile.email.trim().toLowerCase() };
      if (language) update.language = language;
      if (hasEnabledField) {
        update.unsubscribed_at = body.enabled === false
          ? new Date().toISOString()
          : null;
        if (body.enabled === true) update.confirmed_at = new Date().toISOString();
      }
      if (Object.keys(update).length > 0) {
        const { error } = await admin
          .from("email_subscribers")
          .update(update)
          .eq("id", existing.id);
        if (error) return json({ error: error.message }, 500);
      }
    }

    let effectiveOptOut = !!profile.email_opt_out;
    let brevoWarning = "";
    if (hasEnabledField) {
      effectiveOptOut = body.enabled === false;
      const { data: changed, error: optOutError } = await admin.rpc(
        "set_email_global_preference",
        { p_profile_id: userId, p_segment: segment, p_enabled: body.enabled },
      );
      if (optOutError || changed !== true) {
        return json({ error: optOutError?.message || "preference_update_failed" }, 500);
      }
      const brevo = await syncBrevoBlacklist(profile.email, effectiveOptOut);
      if (!brevo.ok) brevoWarning = brevo.error;
    }

    const { data: sub, error: finalSubError } = await admin
      .from("email_subscribers")
      .select(
        "email, language, segment, unsubscribed_at, notify_analytics, notify_video_reviews, notify_position_open, notify_stop_hit, notify_take_profit, notify_manual_close",
      )
      .eq("profile_id", userId)
      .eq("segment", segment)
      .maybeSingle();
    if (finalSubError) return json({ error: finalSubError.message }, 500);
    const flags: Record<string, boolean> = {};
    for (const f of EVENT_FLAGS) {
      flags[f] = sub ? !!sub[f] : f === "notify_video_reviews" ? false : true;
    }
    return json({
      ok: true,
      enabled: !!sub && !sub.unsubscribed_at && !effectiveOptOut,
      email: profile.email,
      language: sub?.language || profile.lang || "ru",
      segment,
      flags,
      warning: brevoWarning || undefined,
    });
  }

  return json({ error: "method_not_allowed" }, 405);
});
