// analytics-republish-section v3
// v3: Architectural alignment with analytics-publish v23.
//     - All section albums (>=2 charts) go through multipart sendMediaGroup (download in
//       edge runtime, push as multipart). This eliminates URL-fetch errors on Telegram side.
//     - Single charts go through multipart sendPhoto.
//     - The `one_by_one` legacy flag is accepted but ignored — the multipart album path
//       is now reliable enough that splitting into per-photo sends is no longer needed.
//     - DB record `mode` is the actual chosen variant, only set after a successful send.
// v2: Added one-by-one fallback (now obsolete).
// v1: Initial.
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const BOT_USERNAME = Deno.env.get("BOT_USERNAME") ?? "BelfedBot";

const supa = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const TG_CAPTION_LIMIT = 1024;
const TG_TEXT_LIMIT = 4096;
const DELAY_BEFORE_MEDIA_GROUP_MS = 1100;
const MAX_RETRIES = 3;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function getCharts(section: any) {
  const arr = Array.isArray(section?.chart_images) ? section.chart_images : [];
  const out: any[] = [];
  for (const it of arr) {
    if (it && typeof it === "object" && typeof it.url === "string" && it.url) {
      out.push({ url: it.url, caption_ru: it.caption_ru, caption_en: it.caption_en });
    }
  }
  if (out.length === 0 && typeof section?.chart_image_url === "string" && section.chart_image_url) {
    out.push({
      url: section.chart_image_url,
      caption_ru: section.chart_caption_ru ?? "",
      caption_en: section.chart_caption_en ?? "",
    });
  }
  return out;
}

function trimCaption(s: string, limit = TG_CAPTION_LIMIT) {
  if (s.length <= limit) return { caption: s, tail: null as string | null };
  const cut = s.lastIndexOf("\n\n", limit - 20);
  if (cut > limit * 0.6) {
    return { caption: s.slice(0, cut) + "\n\n…", tail: s.slice(cut + 2) };
  }
  return { caption: s.slice(0, limit - 20) + "\n…", tail: s.slice(limit - 20) };
}

async function tgFetch(method: string, body: any): Promise<{ ok: boolean; result?: any; error?: string; raw?: any }> {
  let lastError = "unknown"; let lastRaw: any = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      lastRaw = json;
      if (json.ok) return { ok: true, result: json.result };
      if (res.status === 429 || json.parameters?.retry_after) {
        const retryAfter = (json.parameters?.retry_after ?? 1) * 1000 + 200;
        await sleep(Math.min(retryAfter, 10_000));
        continue;
      }
      lastError = `tg_api_error: ${json.error_code} ${json.description}`;
      console.error(`tg ${method} failed:`, json);
      return { ok: false, error: lastError, raw: json };
    } catch (e) {
      lastError = `network: ${String(e)}`;
      await sleep(500 * (attempt + 1));
    }
  }
  return { ok: false, error: lastError, raw: lastRaw };
}

async function tgFetchMultipart(method: string, buildFd: () => FormData): Promise<{ ok: boolean; result?: any; error?: string; raw?: any }> {
  let lastError = "unknown"; let lastRaw: any = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const fd = buildFd();
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, { method: "POST", body: fd });
      const json = await res.json();
      lastRaw = json;
      if (json.ok) return { ok: true, result: json.result };
      if (res.status === 429 || json.parameters?.retry_after) {
        const retryAfter = (json.parameters?.retry_after ?? 1) * 1000 + 200;
        await sleep(Math.min(retryAfter, 10_000));
        continue;
      }
      lastError = `tg_api_error: ${json.error_code} ${json.description}`;
      console.error(`tg ${method} (multipart) failed:`, json);
      return { ok: false, error: lastError, raw: json };
    } catch (e) {
      lastError = `network: ${String(e)}`;
      await sleep(500 * (attempt + 1));
    }
  }
  return { ok: false, error: lastError, raw: lastRaw };
}

async function tgSendMessage(chatId: number, threadId: number | null, text: string, replyTo: number | null, silent = false) {
  const body: any = { chat_id: chatId, text, disable_web_page_preview: true, parse_mode: "HTML" };
  if (threadId != null) body.message_thread_id = threadId;
  if (replyTo != null) body.reply_to_message_id = replyTo;
  if (silent) body.disable_notification = true;
  const r = await tgFetch("sendMessage", body);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  return { msg_id: (r.result?.message_id ?? null) as number | null, error: null as string | null };
}

async function tgSendPhotoMultipart(chatId: number, threadId: number | null, photoUrl: string, caption: string, replyTo: number | null, silent = false) {
  let buf: ArrayBuffer;
  let ct = "image/png";
  let filename = "photo.png";
  try {
    const dl = await fetch(photoUrl);
    if (!dl.ok) return { msg_id: null as number | null, error: `download_failed:${dl.status}` };
    buf = await dl.arrayBuffer();
    ct = dl.headers.get("content-type") ?? "image/png";
    filename = (photoUrl.split("/").pop() ?? "photo.png").split("?")[0];
  } catch (e) {
    return { msg_id: null as number | null, error: `download_error:${String(e)}` };
  }
  const buildFd = () => {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (threadId != null) fd.append("message_thread_id", String(threadId));
    if (replyTo != null) fd.append("reply_to_message_id", String(replyTo));
    if (caption) {
      fd.append("caption", caption);
      fd.append("parse_mode", "HTML");
    }
    if (silent) fd.append("disable_notification", "true");
    fd.append("photo", new Blob([buf], { type: ct }), filename);
    return fd;
  };
  const r = await tgFetchMultipart("sendPhoto", buildFd);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  return { msg_id: (r.result?.message_id ?? null) as number | null, error: null as string | null };
}

async function tgSendMediaGroupMultipart(chatId: number, threadId: number | null, photoUrls: string[], firstCaption: string | null, replyTo: number | null, silent = false) {
  const urls = photoUrls.slice(0, 10);
  const downloads: { name: string; filename: string; buf: ArrayBuffer; ct: string }[] = [];
  for (let i = 0; i < urls.length; i++) {
    try {
      const dl = await fetch(urls[i]);
      if (!dl.ok) return { msg_id: null as number | null, error: `download_failed_${i}:${dl.status}` };
      const buf = await dl.arrayBuffer();
      const ct = dl.headers.get("content-type") ?? "image/png";
      const filename = (urls[i].split("/").pop() ?? `photo${i}.png`).split("?")[0];
      downloads.push({ name: `photo${i}`, filename, buf, ct });
    } catch (e) {
      return { msg_id: null as number | null, error: `download_error_${i}:${String(e)}` };
    }
  }
  const media = downloads.map((d, i) => {
    const m: any = { type: "photo", media: `attach://${d.name}` };
    if (i === 0 && firstCaption) {
      m.caption = firstCaption;
      m.parse_mode = "HTML";
    }
    return m;
  });
  const buildFd = () => {
    const fd = new FormData();
    fd.append("chat_id", String(chatId));
    if (threadId != null) fd.append("message_thread_id", String(threadId));
    if (replyTo != null) fd.append("reply_to_message_id", String(replyTo));
    if (silent) fd.append("disable_notification", "true");
    fd.append("media", JSON.stringify(media));
    for (const d of downloads) {
      fd.append(d.name, new Blob([d.buf], { type: d.ct }), d.filename);
    }
    return fd;
  };
  const r = await tgFetchMultipart("sendMediaGroup", buildFd);
  if (!r.ok) return { msg_id: null as number | null, error: r.error };
  const arr = r.result;
  const msgId = Array.isArray(arr) && arr.length > 0 ? (arr[0].message_id ?? null) : null;
  return { msg_id: msgId as number | null, error: null as string | null };
}

function escapeHtml(s: string) {
  if (!s) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtDate(d: string, lang: string) {
  const [y, m, day] = d.split("-");
  const monthsRu = ["янв","фев","мар","апр","май","июн","июл","авг","сен","окт","ноя","дек"];
  const monthsEn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const months = lang === "ru" ? monthsRu : monthsEn;
  return `${parseInt(day,10)} ${months[parseInt(m,10)-1]} ${y}`;
}

function buildFullFooter(report: any, lang: string) {
  const date = fmtDate(report.report_date, lang);
  const domain = lang === "ru" ? "belfed.ru" : "belfed.com";
  return `· BELFED ANALYTICS · ${date} · @${BOT_USERNAME} · ${domain}`;
}

function buildMiniFooter(partsLabel: string) {
  return `· ${partsLabel}  @${BOT_USERNAME}`;
}

function labelTail(label: string) {
  return label.replace(/^[\s·•\-—]*\d+[.)\s]*\s*/u, "").trim();
}

function buildSectionCaptions(section: any, idx: number, total: number, lang: string, isConclusion: boolean, report: any) {
  const labelRaw = (lang === "ru" ? section.section_label_ru : section.section_label_en) ?? "";
  const label = labelRaw.trim();
  const headlineRaw = (lang === "ru" ? section.headline_ru : section.headline_en) ?? "";
  const body = (lang === "ru" ? section.body_ru : section.body_en) ?? "";
  const charts = getCharts(section);
  const useLegacyChartCap = charts.length <= 1;
  const chartCap = useLegacyChartCap
    ? ((lang === "ru" ? section.chart_caption_ru : section.chart_caption_en) ?? (charts[0]?.[lang === "ru" ? "caption_ru" : "caption_en"] ?? ""))
    : "";
  const partsLabel = isConclusion
    ? (lang === "ru" ? "ГЛАВНЫЙ ВЫВОД" : "KEY TAKEAWAY")
    : (lang === "ru" ? `Часть ${idx + 2}/${total + 1}` : `Part ${idx + 2}/${total + 1}`);

  const labelClean = labelTail(label).toLocaleLowerCase();
  const headlineClean = headlineRaw.trim().toLocaleLowerCase();
  const headline = (headlineClean && headlineClean !== labelClean) ? headlineRaw : "";

  function compose(opts: { includeLabel: boolean; includeChartCap: boolean; includeFullFooter: boolean }) {
    const lines: string[] = [];
    if (opts.includeLabel && label) lines.push(`// ${escapeHtml(label)}`);
    if (headline) lines.push(`<b>${escapeHtml(headline)}</b>`);
    if (lines.length) lines.push("");
    if (body) lines.push(escapeHtml(body));
    if (opts.includeChartCap && chartCap) { if (body) lines.push(""); lines.push(`<i>${escapeHtml(chartCap)}</i>`); }
    lines.push("");
    if (opts.includeFullFooter) {
      lines.push(`· ${partsLabel}`, buildFullFooter(report, lang));
    } else {
      lines.push(buildMiniFooter(partsLabel));
    }
    return lines.join("\n");
  }

  const showFullFooter = !!isConclusion;

  return {
    full:          compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: showFullFooter }),
    compact:       compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: showFullFooter }),
    minimal:       compose({ includeLabel: true,  includeChartCap: false, includeFullFooter: false }),
    ultraMinimal:  compose({ includeLabel: false, includeChartCap: false, includeFullFooter: false }),
    chartCap,
  };
}

async function publishOneSection(
  report: any,
  allSections: any[],
  section: any,
  idx: number,
  lang: string,
  silent: boolean,
  coverMsgId: number,
) {
  const charts = getCharts(section);
  const caps = buildSectionCaptions(section, idx, allSections.length, lang, !!section.is_conclusion, report);

  const tg = lang === "ru" ? report.tg_message_ids_ru : report.tg_message_ids_en;
  const chatId = tg?.chat_id;
  const threadId = tg?.thread_id ?? null;
  if (!chatId) return { ok: false, error: "no_chat_id_in_report_tg_message_ids", photo_msg_id: null, body_msg_id: null, charts: charts.length, mode: "no_chat_id" };

  let photoMsgId: number | null = null;
  let bodyMsgId: number | null = null;
  let mode = "unknown";
  let lastError: string | null = null;

  const candidates: [string, string][] = [
    [caps.full,         "full"],
    [caps.compact,      "compact"],
    [caps.minimal,      "minimal"],
    [caps.ultraMinimal, "ultra_minimal"],
  ];
  let chosen: string | null = null;
  let chosenVariant = "ultra_minimal";
  for (const [text, m] of candidates) {
    if (text.length <= TG_CAPTION_LIMIT) { chosen = text; chosenVariant = m; break; }
  }

  if (charts.length >= 2) {
    await sleep(DELAY_BEFORE_MEDIA_GROUP_MS);
    const urls = charts.map((c: any) => c.url);
    if (chosen) {
      const r = await tgSendMediaGroupMultipart(chatId, threadId, urls, chosen, coverMsgId, silent);
      photoMsgId = r.msg_id;
      lastError = r.error;
      mode = photoMsgId ? `album_caption_${chosenVariant}` : `album_caption_${chosenVariant}_failed`;
    }
    if (!photoMsgId) {
      const r2 = await tgSendMediaGroupMultipart(chatId, threadId, urls, null, coverMsgId, silent);
      photoMsgId = r2.msg_id;
      if (!photoMsgId) {
        lastError = `${lastError ?? ""};fallback_album_failed:${r2.error}`;
      } else {
        mode = "album_then_reply_text";
        const { caption: head, tail } = trimCaption(caps.ultraMinimal);
        const replyText = (tail ? head.replace(/\n\n…$/, "") + "\n\n" + tail : head).slice(0, TG_TEXT_LIMIT);
        await sleep(400);
        const rTxt = await tgSendMessage(chatId, threadId, replyText, photoMsgId, silent);
        bodyMsgId = rTxt.msg_id;
        if (!bodyMsgId) lastError = `${lastError ?? ""};reply_text_failed:${rTxt.error}`;
      }
    }
  } else if (charts.length === 1) {
    const { caption, tail } = trimCaption(caps.full);
    const r = await tgSendPhotoMultipart(chatId, threadId, charts[0].url, caption, coverMsgId, silent);
    photoMsgId = r.msg_id; lastError = r.error;
    mode = photoMsgId ? "single_photo_caption" : "single_photo_caption_failed";
    if (tail && photoMsgId) {
      await sleep(400);
      const rTxt = await tgSendMessage(chatId, threadId, tail.slice(0, TG_TEXT_LIMIT), photoMsgId, silent);
      bodyMsgId = rTxt.msg_id;
    }
  } else {
    const { caption, tail } = trimCaption(caps.full);
    const r = await tgSendMessage(chatId, threadId, caption, coverMsgId, silent);
    photoMsgId = r.msg_id; lastError = r.error;
    mode = photoMsgId ? "no_photo_text_only" : "no_photo_text_only_failed";
    if (tail && photoMsgId) {
      await sleep(400);
      const rTxt = await tgSendMessage(chatId, threadId, tail.slice(0, TG_TEXT_LIMIT), photoMsgId, silent);
      bodyMsgId = rTxt.msg_id;
    }
  }

  return {
    ok: !!photoMsgId,
    photo_msg_id: photoMsgId,
    body_msg_id: bodyMsgId,
    charts: charts.length,
    mode,
    error: lastError,
  };
}

Deno.serve(async (req) => {
  const headers = { "content-type": "application/json" };
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 405, headers });
  if (req.headers.get("x-bot-secret") !== BOT_SECRET) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers });

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers }); }
  const reportId = body.report_id;
  const position = body.position;
  const langs: string[] = body.langs ?? ["ru", "en"];
  const silent = !!body.silent;
  // v3: `one_by_one` is accepted for backward compatibility but ignored.
  if (!reportId || typeof position !== "number") {
    return new Response(JSON.stringify({ ok: false, error: "report_id_and_position_required" }), { status: 400, headers });
  }

  const { data: report, error: rErr } = await supa.from("analytics_reports").select("*").eq("id", reportId).maybeSingle();
  if (rErr || !report) return new Response(JSON.stringify({ ok: false, error: "report_not_found" }), { status: 404, headers });

  const { data: allSections, error: sErr } = await supa.from("analytics_sections").select("*").eq("report_id", reportId).order("position", { ascending: true });
  if (sErr) return new Response(JSON.stringify({ ok: false, error: sErr.message }), { status: 500, headers });
  if (!allSections || allSections.length === 0) return new Response(JSON.stringify({ ok: false, error: "no_sections" }), { status: 404, headers });

  const section = allSections.find((s: any) => s.position === position);
  if (!section) return new Response(JSON.stringify({ ok: false, error: "section_not_found_at_position" }), { status: 404, headers });
  const idx = allSections.findIndex((s: any) => s.position === position);

  const results: any = {};

  for (const lang of langs) {
    const tg = lang === "ru" ? report.tg_message_ids_ru : report.tg_message_ids_en;
    if (!tg?.cover) { results[lang] = { skipped: "no_cover_msg_id" }; continue; }

    const existingSection = Array.isArray(tg.sections) ? tg.sections.find((s: any) => s.position === position) : null;
    if (existingSection?.photo_msg_id && !body.force) {
      results[lang] = { skipped: "already_published", existing: existingSection };
      continue;
    }

    const out = await publishOneSection(report, allSections, section, idx, lang, silent, tg.cover);
    results[lang] = out;

    if (out.ok) {
      const newSectionRecord = {
        section_id: section.id,
        position: section.position,
        photo_msg_id: out.photo_msg_id,
        body_msg_id: out.body_msg_id,
        charts: out.charts,
        mode: out.mode,
      };
      const oldSections = Array.isArray(tg.sections) ? tg.sections : [];
      const newSections = oldSections.map((s: any) =>
        s.position === position ? newSectionRecord : s,
      );
      if (!oldSections.some((s: any) => s.position === position)) {
        newSections.push(newSectionRecord);
        newSections.sort((a: any, b: any) => a.position - b.position);
      }
      const newTg = { ...tg, sections: newSections };
      const updateCol = lang === "ru" ? "tg_message_ids_ru" : "tg_message_ids_en";
      const { error: upErr } = await supa.from("analytics_reports").update({ [updateCol]: newTg }).eq("id", reportId);
      if (upErr) {
        results[lang].db_update_error = upErr.message;
      } else {
        results[lang].db_updated = true;
      }
    }
  }

  return new Response(JSON.stringify({ ok: true, report_id: reportId, position, results }), { status: 200, headers });
});
