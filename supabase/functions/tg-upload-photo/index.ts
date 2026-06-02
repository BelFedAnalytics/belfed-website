// tg-upload-photo v1
// Downloads an image from a URL and sends it to Telegram as multipart/form-data
// (instead of passing the URL to Telegram). Use when Telegram fails to fetch the
// URL itself with WEBPAGE_MEDIA_EMPTY / "wrong type of the web page content".
//
// Auth: x-bot-secret header.
// Request: {"chat_id":<int>, "thread_id":<int|null>, "photo_url":"...",
//           "caption":"...", "reply_to":<int|null>, "silent":bool}

const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;
const TELEGRAM_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

Deno.serve(async (req) => {
  const headers = { "content-type": "application/json" };
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 405, headers });
  if (req.headers.get("x-bot-secret") !== BOT_SECRET) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401, headers });

  let body: any;
  try { body = await req.json(); } catch { return new Response(JSON.stringify({ ok: false, error: "bad_json" }), { status: 400, headers }); }
  const { chat_id, thread_id, photo_url, caption, reply_to, silent } = body ?? {};
  if (!chat_id || !photo_url) return new Response(JSON.stringify({ ok: false, error: "chat_id_and_photo_url_required" }), { status: 400, headers });

  // Download the photo.
  const photoRes = await fetch(photo_url);
  if (!photoRes.ok) return new Response(JSON.stringify({ ok: false, error: `download_failed: ${photoRes.status}` }), { status: 502, headers });
  const photoBuf = await photoRes.arrayBuffer();
  const contentType = photoRes.headers.get("content-type") ?? "image/png";
  const filenameFromUrl = (photo_url.split("/").pop() ?? "photo.png").split("?")[0];

  // Build multipart/form-data.
  const fd = new FormData();
  fd.append("chat_id", String(chat_id));
  if (thread_id != null) fd.append("message_thread_id", String(thread_id));
  if (reply_to != null) fd.append("reply_to_message_id", String(reply_to));
  if (caption) {
    fd.append("caption", String(caption));
    fd.append("parse_mode", "HTML");
  }
  if (silent) fd.append("disable_notification", "true");
  fd.append("photo", new Blob([photoBuf], { type: contentType }), filenameFromUrl);

  const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: fd,
  });
  const tgJson = await tgRes.json();
  if (!tgJson.ok) {
    return new Response(JSON.stringify({ ok: false, error: `tg_api_error: ${tgJson.error_code} ${tgJson.description}`, raw: tgJson }), { status: 502, headers });
  }
  return new Response(JSON.stringify({ ok: true, msg_id: tgJson.result?.message_id ?? null, result: tgJson.result }), { status: 200, headers });
});
