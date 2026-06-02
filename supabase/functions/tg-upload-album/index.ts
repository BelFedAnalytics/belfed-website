// tg-upload-album v1
// Sends a Telegram media-group (album) by FIRST downloading each photo URL
// in the edge function and uploading them to Telegram via multipart/form-data
// (using attach://<name> references in the media JSON).
//
// This avoids Telegram-side URL fetch errors (WEBPAGE_MEDIA_EMPTY /
// "wrong type of the web page content") that occur when Telegram tries to
// pull multiple Supabase Storage URLs in parallel.
//
// Auth: x-bot-secret header.
// Body: {
//   "chat_id": <int>, "thread_id": <int|null>,
//   "photo_urls": ["https://...", ...],   // 2..10
//   "caption": "<HTML, attached to first photo>",
//   "reply_to": <int|null>, "silent": <bool>
// }
// Response: { ok: true, msg_ids: [<int>,...] } or { ok: false, error }

const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;
const TG = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

Deno.serve(async (req) => {
  const headers = { "content-type": "application/json" };
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 405, headers });
  if (req.headers.get("x-bot-secret") !== BOT_SECRET) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers });

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers }); }
  const { chat_id, thread_id, photo_urls, caption, reply_to, silent } = body ?? {};
  if (!chat_id || !Array.isArray(photo_urls) || photo_urls.length < 2 || photo_urls.length > 10) {
    return new Response(JSON.stringify({ ok: false, error: "need_chat_id_and_2_to_10_photo_urls" }), { status: 400, headers });
  }

  // Download each photo in parallel.
  const downloads = await Promise.all(photo_urls.map(async (url: string, i: number) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`download_failed_${i}: ${res.status}`);
    const buf = await res.arrayBuffer();
    const ct = res.headers.get("content-type") ?? "image/png";
    return { name: `photo${i}`, filename: (url.split("/").pop() ?? `photo${i}.png`).split("?")[0], buf, ct };
  })).catch(e => ({ error: String(e) } as any));
  if ((downloads as any).error) return new Response(JSON.stringify({ ok: false, error: (downloads as any).error }), { status: 502, headers });

  // Build media JSON, referencing attached files via attach://<name>.
  const media = (downloads as any[]).map((d, i) => {
    const m: any = { type: "photo", media: `attach://${d.name}` };
    if (i === 0 && caption) {
      m.caption = String(caption);
      m.parse_mode = "HTML";
    }
    return m;
  });

  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  if (thread_id != null) fd.append("message_thread_id", String(thread_id));
  if (reply_to != null) fd.append("reply_to_message_id", String(reply_to));
  if (silent) fd.append("disable_notification", "true");
  fd.append("media", JSON.stringify(media));
  for (const d of downloads as any[]) {
    fd.append(d.name, new Blob([d.buf], { type: d.ct }), d.filename);
  }

  const tgRes = await fetch(`https://api.telegram.org/bot${TG}/sendMediaGroup`, { method: "POST", body: fd });
  const tgJson = await tgRes.json();
  if (!tgJson.ok) {
    return new Response(JSON.stringify({ ok: false, error: `tg_api_error: ${tgJson.error_code} ${tgJson.description}`, raw: tgJson }), { status: 502, headers });
  }
  const msgIds = Array.isArray(tgJson.result) ? tgJson.result.map((r: any) => r.message_id) : [];
  return new Response(JSON.stringify({ ok: true, msg_ids: msgIds, first_msg_id: msgIds[0] ?? null }), { status: 200, headers });
});
