// chart-request edge function — v15 (auto-expire removed)
// v15 (2026-08-24): removed the 48h auto-expire behaviour entirely. Requests
//                  now stay 'pending' indefinitely until an admin fulfils,
//                  rejects, or clarifies them — the expireOld() calls and the
//                  chart_requests_expire_old() RPC are no longer invoked here
//                  (the RPC itself was turned into a no-op via migration, and
//                  previously auto-expired rows were restored to 'pending').
// v14 (2026-08-06): admin_fulfill now accepts optional note_ru / note_en / chart_url
//                  and includes them in the fulfilment DM, mirroring the layout
//                  used by analysis-publish ("График: <url>"). With
//                  update_post_chart=true the chart_url is also written back to
//                  analysis_posts.tradingview_url. All four are optional — when
//                  omitted the DM is byte-identical to v13, so the existing
//                  admin-analysis-posts.html publish flow is unaffected.
//                  Driven by the new [ ПРИВЯЗАТЬ К ПОСТУ ] action in
//                  admin-chart-requests.html, which answers a request with an
//                  already-published post instead of publishing a new one.
// v11 (2026-06-26): quota is now read from profiles.chart_quota_per_day instead
//                  of the global QUOTA_PER_DAY constant. New users get 1/day by
//                  default (column default); existing active/trial/admin users
//                  were backfilled to 3 via the add_chart_quota_per_day migration.
// v9 (2026-06-22): added admin_clarify action — sends Telegram DM + Resend email
//                  to the requester asking them to clarify the ticker or provide
//                  the company name. Stamps clarification_sent_at on the row.
// v8 (2026-06-16): admin_fulfill DM URL now uses canonical ?slug=&ticker= format
//                  that asset-analysis.html parsePermalink() understands.
// Actions:
//   - submit:          user submits a new request
//   - my_quota:        returns remaining quota + user's recent requests
//   - admin_list:      admin pulls full queue (grouped by ticker)
//   - admin_fulfill:   admin marks request fulfilled, links to analysis post, triggers DM
//   - admin_reject:    admin rejects with reason, sends DM with support button
//   - admin_clarify:   admin sends clarification request via TG DM + email
// Auth: JWT required. Admin actions additionally require subscription_status='admin'.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL              = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_SHARED_SECRET         = Deno.env.get("BOT_SHARED_SECRET")!;
const TELEGRAM_BOT_TOKEN        = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TELEGRAM_BOT_USERNAME     = Deno.env.get("TELEGRAM_BOT_USERNAME") || "BelfedBot";
const RESEND_API_KEY            = Deno.env.get("RESEND_API_KEY") ?? "";
const EMAIL_FROM                = Deno.env.get("EMAIL_FROM") ?? "BelFed Analytics <analytics@belfed.com>";
const SUPPORT_EMAIL             = Deno.env.get("SUPPORT_EMAIL") ?? "support@belfed.com";

const PAID_STATUSES = new Set(["active", "trial", "admin"]);
const DEFAULT_QUOTA_PER_DAY = 1; // fallback when profiles.chart_quota_per_day is NULL (column is NOT NULL DEFAULT 1)
const TICKER_RE     = /^[A-Z0-9]{1,8}$/;
const ASSET_CLASSES = new Set(["stocks", "crypto", "commodities", "fx"]);

const ADMIN_URL_RU = "https://belfed.ru/admin-chart-requests.html";
const ADMIN_URL_EN = "https://belfed.com/admin-chart-requests.html";

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-bot-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeMd(text: string): string {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, "\\$&");
}

function isPaidProfile(p: { subscription_status: string | null; subscription_expires_at: string | null }): boolean {
  if (!p) return false;
  if (!PAID_STATUSES.has(p.subscription_status ?? "")) return false;
  if (p.subscription_status === "admin") return true;
  if (p.subscription_expires_at) {
    const exp = new Date(p.subscription_expires_at).getTime();
    if (exp < Date.now()) return false;
  }
  return true;
}

async function tgSendMessage(chatId: string, text: string, opts: Record<string, unknown> = {}): Promise<{ ok: boolean; result?: any; error?: string }> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...opts }),
    });
    const data = await r.json();
    return { ok: !!data.ok, result: data.result, error: data.description };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function resolveTgTarget(profileRow: any): Promise<{ telegram_id: string | null; lang: string | null }> {
  const direct = profileRow?.profiles ?? null;
  if (direct?.telegram_id) {
    return { telegram_id: String(direct.telegram_id), lang: direct.lang ?? null };
  }
  if (direct?.merged_into_user_id) {
    const { data: target } = await admin
      .from("profiles")
      .select("telegram_id, lang")
      .eq("id", direct.merged_into_user_id)
      .maybeSingle();
    if (target?.telegram_id) {
      return { telegram_id: String(target.telegram_id), lang: target.lang ?? direct.lang ?? null };
    }
  }
  return { telegram_id: null, lang: direct?.lang ?? null };
}

async function computeResetInHours(userId: string): Promise<number> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: oldest } = await admin
    .from("chart_requests")
    .select("created_at")
    .eq("user_id", userId)
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  const oldestMs = oldest ? new Date(oldest.created_at).getTime() : Date.now();
  return Math.max(1, Math.ceil((oldestMs + 24 * 3600_000 - Date.now()) / 3600_000));
}

function supportKeyboard(lang: string) {
  const label = lang === "en" ? "💬 Contact support" : "💬 Связаться с поддержкой";
  const url = `https://t.me/${TELEGRAM_BOT_USERNAME}?start=support`;
  return { inline_keyboard: [[{ text: label, url }]] };
}

async function notifyAdminsNewRequest(opts: {
  request_id: string;
  ticker: string;
  asset_class: string | null;
  source: string;
  requester_email: string | null;
  requester_tg_username: string | null;
  requester_lang: string | null;
}) {
  try {
    const { data: admins, error: aErr } = await admin
      .from("profiles")
      .select("id, telegram_id, lang")
      .eq("subscription_status", "admin")
      .not("telegram_id", "is", null);
    if (aErr || !admins || admins.length === 0) {
      if (aErr) console.error("notifyAdminsNewRequest: admin lookup failed", aErr.message);
      return;
    }

    const { count: pendingCount } = await admin
      .from("chart_requests")
      .select("id", { count: "exact", head: true })
      .eq("ticker", opts.ticker)
      .eq("status", "pending");
    const totalPending = pendingCount ?? 1;

    const tickerEsc = escapeHtml(opts.ticker);
    const assetEsc = opts.asset_class ? escapeHtml(opts.asset_class) : null;
    const emailEsc = opts.requester_email ? escapeHtml(opts.requester_email) : "—";
    const usernamePart = opts.requester_tg_username
      ? ` (@${escapeHtml(opts.requester_tg_username)})`
      : "";
    const sourceLabelRu = opts.source === "web" ? "сайт" : "Telegram";
    const sourceLabelEn = opts.source === "web" ? "web" : "Telegram";

    for (const a of admins) {
      const lang = a.lang === "en" ? "en" : "ru";
      const adminUrl = lang === "en" ? ADMIN_URL_EN : ADMIN_URL_RU;
      const text = lang === "en"
        ? [
            `📥 <b>New chart request</b>`,
            ``,
            `Ticker: <b>${tickerEsc}</b>${assetEsc ? ` · ${assetEsc}` : ""}`,
            `From: ${emailEsc}${usernamePart}`,
            `Source: ${sourceLabelEn}`,
            `Pending for ${tickerEsc}: <b>${totalPending}</b>`,
          ].join("\n")
        : [
            `📥 <b>Новый запрос на тикер</b>`,
            ``,
            `Тикер: <b>${tickerEsc}</b>${assetEsc ? ` · ${assetEsc}` : ""}`,
            `От: ${emailEsc}${usernamePart}`,
            `Источник: ${sourceLabelRu}`,
            `В очереди по ${tickerEsc}: <b>${totalPending}</b>`,
          ].join("\n");

      const reply_markup = {
        inline_keyboard: [[{
          text: lang === "en" ? "📊 Open admin" : "📊 Открыть админку",
          url: adminUrl,
        }]],
      };

      const sent = await tgSendMessage(String(a.telegram_id), text, { reply_markup });
      if (!sent.ok) {
        console.error("notifyAdminsNewRequest: send failed", { admin_id: a.id, error: sent.error });
      }
    }
  } catch (e) {
    console.error("notifyAdminsNewRequest unhandled error:", String(e));
  }
}

async function handleBotRequest(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const tgId = String(body.telegram_id ?? "").trim();
  const ticker = String(body.ticker ?? "").trim().toUpperCase();
  const assetClass = body.asset_class ? String(body.asset_class).toLowerCase() : null;
  if (!tgId) return json({ error: "telegram_id_required" }, 400);
  if (!TICKER_RE.test(ticker)) return json({ error: "invalid_ticker" }, 400);
  if (assetClass && !ASSET_CLASSES.has(assetClass)) return json({ error: "invalid_asset_class" }, 400);

  const { data: profile, error: pErr } = await admin
    .from("profiles")
    .select("id, email, telegram_username, subscription_status, subscription_expires_at, lang, telegram_id, chart_quota_per_day")
    .eq("telegram_id", tgId)
    .maybeSingle();
  if (pErr) return json({ error: "lookup_failed", details: String(pErr.message ?? "") }, 500);
  if (!profile) return json({ error: "not_linked" }, 404);
  if (!isPaidProfile(profile)) return json({ error: "not_paid" }, 403);

  const userQuota = Number(profile.chart_quota_per_day ?? DEFAULT_QUOTA_PER_DAY);

  const { data: dup } = await admin
    .from("chart_requests")
    .select("id")
    .eq("user_id", profile.id)
    .eq("ticker", ticker)
    .eq("status", "pending")
    .limit(1)
    .maybeSingle();
  if (dup) return json({ error: "duplicate_pending", request_id: dup.id }, 409);

  const { data: cnt, error: cErr } = await admin.rpc("chart_request_count_24h", { p_user_id: profile.id });
  if (cErr) return json({ error: "quota_check_failed", details: String(cErr.message ?? "") }, 500);
  const used = Number(cnt ?? 0);
  if (used >= userQuota) {
    const resetInHours = await computeResetInHours(profile.id);
    return json({ error: "quota_exceeded", used, limit: userQuota, reset_in_hours: resetInHours }, 429);
  }

  const { data: ins, error: iErr } = await admin
    .from("chart_requests")
    .insert({ user_id: profile.id, ticker, asset_class: assetClass, source: "telegram" })
    .select("id, ticker, asset_class, status, created_at")
    .single();
  if (iErr) return json({ error: "insert_failed", details: String(iErr.message ?? "") }, 500);

  notifyAdminsNewRequest({
    request_id: ins.id,
    ticker,
    asset_class: assetClass,
    source: "telegram",
    requester_email: profile.email ?? null,
    requester_tg_username: profile.telegram_username ?? null,
    requester_lang: profile.lang ?? null,
  }).catch(e => console.error("notifyAdminsNewRequest swallow:", String(e)));

  return json({ ok: true, request: ins, used: used + 1, used_24h: used + 1, limit: userQuota, remaining: Math.max(0, userQuota - used - 1), lang: profile.lang });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  const botSecret = req.headers.get("x-bot-secret");
  if (botSecret) {
    if (botSecret !== BOT_SHARED_SECRET) return json({ error: "unauthorized" }, 401);
    return await handleBotRequest(req);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!jwt) return json({ error: "unauthorized", reason: "missing_jwt" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  if (userErr || !userData?.user) return json({ error: "unauthorized", reason: "invalid_jwt" }, 401);
  const userId = userData.user.id;

  const { data: profile, error: pErr } = await admin
    .from("profiles")
    .select("id, email, telegram_username, subscription_status, subscription_expires_at, lang, telegram_id, chart_quota_per_day")
    .eq("id", userId)
    .maybeSingle();
  if (pErr || !profile) return json({ error: "forbidden", reason: "no_profile" }, 403);

  const userQuota = Number(profile.chart_quota_per_day ?? DEFAULT_QUOTA_PER_DAY);

  let body: Record<string, any>;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = String(body.action ?? "");
  const isAdmin = profile.subscription_status === "admin";

  if (action === "submit") {
    if (!isPaidProfile(profile)) return json({ error: "not_paid" }, 403);
    const ticker = String(body.ticker ?? "").trim().toUpperCase();
    if (!TICKER_RE.test(ticker)) return json({ error: "invalid_ticker" }, 400);
    const assetClass = body.asset_class ? String(body.asset_class).toLowerCase() : null;
    if (assetClass && !ASSET_CLASSES.has(assetClass)) return json({ error: "invalid_asset_class" }, 400);

    const { data: dup } = await admin
      .from("chart_requests")
      .select("id")
      .eq("user_id", profile.id)
      .eq("ticker", ticker)
      .eq("status", "pending")
      .limit(1)
      .maybeSingle();
    if (dup) return json({ error: "duplicate_pending", request_id: dup.id }, 409);

    const { data: cnt, error: cErr } = await admin.rpc("chart_request_count_24h", { p_user_id: profile.id });
    if (cErr) return json({ error: "quota_check_failed", details: String(cErr.message ?? "") }, 500);
    const used = Number(cnt ?? 0);
    if (used >= userQuota) {
      const resetInHours = await computeResetInHours(profile.id);
      return json({ error: "quota_exceeded", used, limit: userQuota, reset_in_hours: resetInHours }, 429);
    }

    const { data: ins, error: iErr } = await admin
      .from("chart_requests")
      .insert({ user_id: profile.id, ticker, asset_class: assetClass, source: "web" })
      .select("id, ticker, asset_class, status, created_at")
      .single();
    if (iErr) return json({ error: "insert_failed", details: String(iErr.message ?? "") }, 500);

    notifyAdminsNewRequest({
      request_id: ins.id, ticker, asset_class: assetClass, source: "web",
      requester_email: profile.email ?? null,
      requester_tg_username: profile.telegram_username ?? null,
      requester_lang: profile.lang ?? null,
    }).catch(e => console.error("notifyAdminsNewRequest swallow:", String(e)));

    return json({ ok: true, request: ins, used: used + 1, used_24h: used + 1, limit: userQuota, remaining: Math.max(0, userQuota - used - 1) });
  }

  if (action === "my_quota") {
    if (!isPaidProfile(profile)) return json({ ok: true, paid: false, used: 0, used_24h: 0, limit: userQuota, remaining: 0, requests: [] });
    const { data: cnt, error: cErr } = await admin.rpc("chart_request_count_24h", { p_user_id: profile.id });
    if (cErr) return json({ error: "quota_check_failed", details: String(cErr.message ?? "") }, 500);
    const used = Number(cnt ?? 0);
    const { data: reqs, error: rErr } = await admin
      .from("chart_requests")
      .select("id, ticker, asset_class, status, created_at, fulfilled_at, fulfilled_by_post_id, rejected_reason")
      .eq("user_id", profile.id)
      .order("created_at", { ascending: false })
      .limit(10);
    if (rErr) return json({ error: "list_failed", details: String(rErr.message ?? "") }, 500);
    return json({ ok: true, paid: true, used, used_24h: used, limit: userQuota, remaining: Math.max(0, userQuota - used), requests: reqs ?? [] });
  }

  if (action === "admin_list") {
    if (!isAdmin) return json({ error: "forbidden", reason: "not_admin" }, 403);

    const { data: pending, error: pe } = await admin
      .from("chart_requests")
      .select("id, user_id, ticker, asset_class, status, created_at, source, clarification_sent_at, profiles!chart_requests_user_id_fkey(email, lang, telegram_id, merged_into_user_id)")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (pe) return json({ error: "list_failed", details: String(pe.message ?? "") }, 500);

    const groups: Record<string, any> = {};
    for (const r of (pending ?? []) as any[]) {
      const key = r.ticker;
      if (!groups[key]) groups[key] = {
        ticker: r.ticker,
        asset_class: r.asset_class,
        count: 0,
        oldest_at: r.created_at,
        newest_at: r.created_at,
        requests: [],
      };
      groups[key].count++;
      if (r.created_at < groups[key].oldest_at) groups[key].oldest_at = r.created_at;
      if (r.created_at > groups[key].newest_at) groups[key].newest_at = r.created_at;
      if (!groups[key].asset_class && r.asset_class) groups[key].asset_class = r.asset_class;
      groups[key].requests.push({
        id: r.id,
        user_id: r.user_id,
        email: r.profiles?.email ?? null,
        lang: r.profiles?.lang ?? null,
        telegram_id: r.profiles?.telegram_id ?? null,
        created_at: r.created_at,
        source: r.source,
        clarification_sent_at: r.clarification_sent_at ?? null,
      });
    }
    const grouped = Object.values(groups).sort((a: any, b: any) => (a.oldest_at < b.oldest_at ? -1 : 1));

    const since = new Date(Date.now() - 7 * 86400_000).toISOString();
    const { data: recent, error: re } = await admin
      .from("chart_requests")
      .select("id, user_id, ticker, status, created_at, fulfilled_at, fulfilled_by_post_id, rejected_reason, profiles!chart_requests_user_id_fkey(email, lang)")
      .in("status", ["fulfilled", "rejected", "expired"])
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(50);
    if (re) return json({ error: "recent_failed", details: String(re.message ?? "") }, 500);

    return json({
      ok: true,
      pending_total: (pending ?? []).length,
      groups: grouped,
      recent: (recent ?? []).map((r: any) => ({ ...r, email: r.profiles?.email ?? null, lang: r.profiles?.lang ?? null, profiles: undefined })),
    });
  }

  if (action === "admin_fulfill") {
    if (!isAdmin) return json({ error: "forbidden", reason: "not_admin" }, 403);
    const requestId = String(body.request_id ?? "").trim();
    const postId    = String(body.post_id ?? "").trim();
    if (!requestId) return json({ error: "request_id_required" }, 400);
    if (!postId)    return json({ error: "post_id_required" }, 400);

    // v14 optional extras. Empty/omitted => v13 behaviour.
    const noteRu   = String(body.note_ru ?? body.note ?? "").trim().slice(0, 2500);
    const noteEnIn = String(body.note_en ?? "").trim().slice(0, 2500);
    const chartUrl = String(body.chart_url ?? "").trim().slice(0, 500);
    const updatePostChart = body.update_post_chart === true;
    if (chartUrl && !/^https:\/\/\S+$/i.test(chartUrl)) {
      return json({ error: "bad_chart_url", reason: "must_be_https" }, 400);
    }

    const { data: r, error: lErr } = await admin
      .from("chart_requests")
      .select("id, user_id, ticker, status, profiles!chart_requests_user_id_fkey(telegram_id, lang, merged_into_user_id)")
      .eq("id", requestId)
      .maybeSingle();
    if (lErr) return json({ error: "load_failed", details: String(lErr.message ?? "") }, 500);
    if (!r)   return json({ error: "not_found" }, 404);
    if (r.status !== "pending") return json({ error: "not_pending", current_status: r.status }, 409);

    const { data: post, error: postErr } = await admin
      .from("analysis_posts")
      .select("id, ticker, slug, message_id_ru, message_id_en, status")
      .eq("id", postId)
      .maybeSingle();
    if (postErr) return json({ error: "post_load_failed", details: String(postErr.message ?? "") }, 500);
    if (!post)   return json({ error: "post_not_found" }, 404);

    const { data: siblings, error: sibErr } = await admin
      .from("chart_requests")
      .select("id, user_id, profiles!chart_requests_user_id_fkey(telegram_id, lang, merged_into_user_id)")
      .eq("ticker", r.ticker)
      .eq("status", "pending");
    if (sibErr) return json({ error: "siblings_failed", details: String(sibErr.message ?? "") }, 500);

    const idsToFulfill = (siblings ?? []).map((s: any) => s.id);
    if (!idsToFulfill.includes(requestId)) idsToFulfill.push(requestId);

    const { error: upErr } = await admin
      .from("chart_requests")
      .update({ status: "fulfilled", fulfilled_at: new Date().toISOString(), fulfilled_by_post_id: postId })
      .in("id", idsToFulfill);
    if (upErr) return json({ error: "update_failed", details: String(upErr.message ?? "") }, 500);

    // Optionally attach a fresh chart to the post itself.
    if (updatePostChart && chartUrl) {
      const { error: tvErr } = await admin
        .from("analysis_posts")
        .update({ tradingview_url: chartUrl })
        .eq("id", postId);
      if (tvErr) console.error("admin_fulfill: tradingview_url update failed", tvErr.message);
    }

    const notified: Array<{ user_id: string; ok: boolean; error?: string }> = [];
    const baseUrlRu = "https://belfed.ru";
    const baseUrlEn = "https://belfed.com";
    const slugForUrl   = post.slug || post.id;
    const tickerForUrl = post.ticker || r.ticker;
    const noteEn = noteEnIn || noteRu; // EN falls back to the RU note

    // Mirrors the analysis-publish layout: headline, note, "График: <url>", CTA.
    function buildDm(lang: "ru" | "en", url: string): string {
      const lines: string[] = [];
      lines.push(lang === "en"
        ? `✅ Your chart request <b>${escapeHtml(r.ticker)}</b> is ready.`
        : `✅ Ваш запрос по <b>${escapeHtml(r.ticker)}</b> готов.`);
      lines.push("");
      const note = lang === "en" ? noteEn : noteRu;
      if (note) { lines.push(escapeHtml(note)); lines.push(""); }
      if (chartUrl) {
        lines.push(`${lang === "en" ? "Chart" : "График"}: ${escapeHtml(chartUrl)}`);
        lines.push("");
      }
      lines.push(lang === "en"
        ? `<a href="${url}">Open analysis →</a>`
        : `<a href="${url}">Открыть анализ →</a>`);
      return lines.join("\n");
    }

    for (const s of (siblings ?? []) as any[]) {
      const target = await resolveTgTarget(s);
      const tgid = target.telegram_id;
      if (!tgid) { notified.push({ user_id: s.user_id, ok: false, error: "no_telegram_id" }); continue; }
      const lang = target.lang === "en" ? "en" : "ru";
      const url = (lang === "en" ? baseUrlEn : baseUrlRu)
        + `/asset-analysis.html?slug=${encodeURIComponent(slugForUrl)}&ticker=${encodeURIComponent(tickerForUrl)}`;
      const text = buildDm(lang, url);
      const sent = await tgSendMessage(String(tgid), text, { disable_web_page_preview: false });
      notified.push({ user_id: s.user_id, ok: sent.ok, error: sent.error });
    }

    const okUserIds = notified.filter(n => n.ok).map(n => n.user_id);
    if (okUserIds.length > 0) {
      await admin.from("chart_requests")
        .update({ notified_at: new Date().toISOString() })
        .in("id", idsToFulfill)
        .in("user_id", okUserIds);
    }

    return json({
      ok: true,
      fulfilled_count: idsToFulfill.length,
      ticker: r.ticker,
      post_id: postId,
      chart_url: chartUrl || null,
      post_chart_updated: !!(updatePostChart && chartUrl),
      notified,
    });
  }

  if (action === "admin_reject") {
    if (!isAdmin) return json({ error: "forbidden", reason: "not_admin" }, 403);
    const requestId = String(body.request_id ?? "").trim();
    const reason    = String(body.reason ?? "").trim().slice(0, 200);
    const rejectAllTicker = body.reject_all_ticker === true;
    if (!requestId) return json({ error: "request_id_required" }, 400);

    const { data: r, error: lErr } = await admin
      .from("chart_requests")
      .select("id, ticker, status")
      .eq("id", requestId)
      .maybeSingle();
    if (lErr) return json({ error: "load_failed", details: String(lErr.message ?? "") }, 500);
    if (!r)   return json({ error: "not_found" }, 404);
    if (r.status !== "pending") return json({ error: "not_pending", current_status: r.status }, 409);

    let idsToReject: string[] = [requestId];
    let siblingsForDm: any[] = [];
    if (rejectAllTicker) {
      const { data: sibs, error: sibErr } = await admin
        .from("chart_requests")
        .select("id, user_id, profiles!chart_requests_user_id_fkey(telegram_id, lang, merged_into_user_id)")
        .eq("ticker", r.ticker)
        .eq("status", "pending");
      if (sibErr) return json({ error: "siblings_failed", details: String(sibErr.message ?? "") }, 500);
      idsToReject = (sibs ?? []).map((s: any) => s.id);
      siblingsForDm = sibs ?? [];
    } else {
      const { data: one, error: oneErr } = await admin
        .from("chart_requests")
        .select("id, user_id, profiles!chart_requests_user_id_fkey(telegram_id, lang, merged_into_user_id)")
        .eq("id", requestId)
        .maybeSingle();
      if (oneErr) return json({ error: "load_failed", details: String(oneErr.message ?? "") }, 500);
      if (one) siblingsForDm = [one];
    }

    const { error: upErr } = await admin
      .from("chart_requests")
      .update({ status: "rejected", rejected_reason: reason || null })
      .in("id", idsToReject);
    if (upErr) return json({ error: "update_failed", details: String(upErr.message ?? "") }, 500);

    const notified: Array<{ user_id: string; ok: boolean; error?: string }> = [];
    for (const s of siblingsForDm) {
      const target = await resolveTgTarget(s);
      const tgid = target.telegram_id;
      if (!tgid) { notified.push({ user_id: s.user_id, ok: false, error: "no_telegram_id" }); continue; }
      const lang = target.lang === "en" ? "en" : "ru";
      const txt = lang === "en"
        ? `Your chart request <b>${r.ticker}</b> was not accepted.${reason ? `\n\nReason: ${reason}` : ""}`
        : `Ваш запрос по <b>${r.ticker}</b> не принят.${reason ? `\n\nПричина: ${reason}` : ""}`;
      const sent = await tgSendMessage(String(tgid), txt, { reply_markup: supportKeyboard(lang), disable_web_page_preview: false });
      notified.push({ user_id: s.user_id, ok: sent.ok, error: sent.error });
    }

    const okUserIds = Array.from(new Set(notified.filter(n => n.ok).map(n => n.user_id)));
    if (okUserIds.length > 0) {
      await admin.from("chart_requests")
        .update({ notified_at: new Date().toISOString() })
        .in("id", idsToReject)
        .in("user_id", okUserIds);
    }

    return json({ ok: true, rejected_count: idsToReject.length, ticker: r.ticker, notified });
  }

  if (action === "admin_clarify") {
    if (!isAdmin) return json({ error: "forbidden", reason: "not_admin" }, 403);

    const requestId   = String(body.request_id ?? "").trim();
    const message     = String(body.message ?? "").trim().slice(0, 500);
    if (!requestId) return json({ error: "request_id_required" }, 400);
    if (!message)   return json({ error: "message_required" }, 400);

    const { data: r, error: lErr } = await admin
      .from("chart_requests")
      .select("id, ticker, user_id, source, profiles!chart_requests_user_id_fkey(telegram_id, lang, merged_into_user_id)")
      .eq("id", requestId)
      .maybeSingle();
    if (lErr) return json({ error: "load_failed", details: String(lErr.message ?? "") }, 500);
    if (!r)   return json({ error: "not_found" }, 404);

    const target = await resolveTgTarget(r);
    const tgId   = target.telegram_id;
    const lang   = target.lang === "en" ? "en" : "ru";
    const ticker = r.ticker?.toUpperCase() ?? "???";

    let email: string | null = null;
    const { data: authUser } = await admin.auth.admin.getUserById(r.user_id);
    email = authUser?.user?.email ?? null;

    let sent_tg    = false;
    let sent_email = false;
    let clarification_message_id: string | null = null;

    if (tgId) {
      const tgText = lang === "en"
        ? [
            `📋 <b>Clarification needed — $${escapeHtml(ticker)}</b>`,
            ``,
            escapeHtml(message),
            ``,
            `<i>Not sure of the ticker? Just tell us the company name and we'll find it.</i>`,
            ``,
            `You can reply via /support in this bot or by email.`,
          ].join("\n")
        : [
            `📋 <b>Уточнение по запросу — $${escapeHtml(ticker)}</b>`,
            ``,
            escapeHtml(message),
            ``,
            `<i>Не знаете тикер? Просто напишите название компании — мы найдём сами.</i>`,
            ``,
            `Ответьте через /support в этом боте или по email.`,
          ].join("\n");

      const keyboard = {
        inline_keyboard: [[{
          text: lang === "en" ? "💬 Write to support" : "💬 Написать в поддержку",
          url: `https://t.me/${TELEGRAM_BOT_USERNAME}?start=support`,
        }]],
      };

      const sent = await tgSendMessage(String(tgId), tgText, { reply_markup: keyboard, disable_web_page_preview: true });
      sent_tg = sent.ok;
      if (!sent_tg) console.error("admin_clarify: TG send failed", sent.error);
    }

    if (email && RESEND_API_KEY.startsWith("re_")) {
      const htmlBody = `
<div style="font-family:'Courier New',Courier,monospace;max-width:600px;margin:0 auto;background:#f5f2eb;">
  <div style="background:#000;padding:16px 28px;text-align:center;">
    <span style="color:#f5f2eb;font-size:13px;letter-spacing:4px;font-weight:bold;">— BELFED_ ANALYTICS —</span>
  </div>
  <div style="padding:28px 28px 8px;background:#f5f2eb;">
    <p style="font-size:12px;letter-spacing:2px;font-weight:bold;margin:0 0 18px;color:#000;">// CHART REQUEST: CLARIFICATION NEEDED</p>
    <p style="font-size:13px;line-height:1.7;margin:0 0 16px;color:#000;">
      We received your chart request for <strong>$${ticker}</strong>, but couldn't find this ticker in our system.
    </p>
    <div style="border-left:3px solid #000;padding:12px 18px;margin:0 0 20px;background:#fff;">
      <p style="font-size:12px;line-height:1.75;margin:0;color:#000;">${message.replace(/\n/g, "<br>")}</p>
    </div>
    <div style="background:#fff;border:1px solid #000;padding:16px 18px;margin:0 0 20px;">
      <p style="font-size:11px;letter-spacing:2px;font-weight:bold;margin:0 0 12px;color:#000;">// HOW TO REPLY</p>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;margin-bottom:12px;">
        <tr>
          <td style="width:36px;vertical-align:top;padding-top:2px;">
            <span style="font-size:10px;letter-spacing:1px;padding:3px 6px;background:#000;color:#f5f2eb;display:inline-block;">01</span>
          </td>
          <td style="padding-left:10px;">
            <p style="font-size:12px;font-weight:bold;margin:0 0 3px;color:#000;">Reply to this email</p>
            <p style="font-size:11px;line-height:1.6;margin:0;color:#555;">Hit <strong>Reply</strong> and tell us the correct ticker or the company name.</p>
          </td>
        </tr>
      </table>
      <table cellpadding="0" cellspacing="0" border="0" style="width:100%;">
        <tr>
          <td style="width:36px;vertical-align:top;padding-top:2px;">
            <span style="font-size:10px;letter-spacing:1px;padding:3px 6px;background:#000;color:#f5f2eb;display:inline-block;">02</span>
          </td>
          <td style="padding-left:10px;">
            <p style="font-size:12px;font-weight:bold;margin:0 0 3px;color:#000;">Write to us via the bot</p>
            <p style="font-size:11px;line-height:1.6;margin:0;color:#555;">Open @BelfedBot and send <strong>/support</strong> with the company name or corrected ticker.</p>
          </td>
        </tr>
      </table>
    </div>
    <p style="font-size:11px;line-height:1.65;margin:0 0 22px;color:#666;">
      Not sure about the ticker? Just tell us the company name — e.g. <em>"Westpac Banking"</em> — and we'll find it for you.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
      <tr>
        <td style="padding-right:10px;">
          <a href="https://t.me/${TELEGRAM_BOT_USERNAME}?start=support" style="display:inline-block;background:#000;color:#f5f2eb;font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;padding:11px 20px;text-decoration:none;border:1px solid #000;">[ OPEN BOT ]</a>
        </td>
        <td>
          <a href="mailto:${SUPPORT_EMAIL}?subject=Re:%20Chart%20request%20clarification:%20%24${encodeURIComponent(ticker)}" style="display:inline-block;background:#fff;color:#000;font-family:'Courier New',monospace;font-size:11px;letter-spacing:2px;padding:10px 20px;text-decoration:none;border:1px solid #000;">[ REPLY BY EMAIL ]</a>
        </td>
      </tr>
    </table>
    <div style="border-top:1px solid #ccc;margin-bottom:18px;"></div>
    <p style="font-size:10px;letter-spacing:1px;color:#888;line-height:1.8;margin:0 0 28px;">
      — BelFed Analytics Team<br>
      <a href="mailto:${SUPPORT_EMAIL}" style="color:#888;">${SUPPORT_EMAIL}</a><br><br>
      You received this because you submitted a chart request as a BelFed subscriber.
    </p>
  </div>
</div>`;

      const resendRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
        body: JSON.stringify({
          from: EMAIL_FROM,
          to: [email],
          reply_to: SUPPORT_EMAIL,
          subject: `Chart request clarification: $${ticker}`,
          html: htmlBody,
        }),
      });

      if (resendRes.ok) {
        sent_email = true;
        const resendData = await resendRes.json();
        clarification_message_id = resendData?.id ?? null;
      } else {
        const errText = await resendRes.text();
        console.error("admin_clarify: Resend send failed", resendRes.status, errText);
      }
    }

    const updatePayload: Record<string, unknown> = {
      clarification_sent_at: new Date().toISOString(),
    };
    if (clarification_message_id) {
      updatePayload.clarification_message_id = clarification_message_id;
    }
    await admin.from("chart_requests").update(updatePayload).eq("id", requestId);

    return json({ ok: true, sent_tg, sent_email });
  }

  return json({ error: "unknown_action", action }, 400);
});
