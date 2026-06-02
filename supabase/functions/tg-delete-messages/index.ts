// tg-delete-messages v1
// Bulk-delete Telegram messages. Auth: x-bot-secret header.
// Body: {"chat_id":<int>, "message_ids":[<int>,...]}
const BOT_SECRET = Deno.env.get("BOT_SHARED_SECRET")!;
const TG = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ ok: false, error: "method" }), { status: 405 });
  if (req.headers.get("x-bot-secret") !== BOT_SECRET) return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), { status: 401 });
  const body = await req.json();
  const { chat_id, message_ids } = body;
  if (!chat_id || !Array.isArray(message_ids)) return new Response(JSON.stringify({ ok: false, error: "need_chat_id_and_message_ids" }), { status: 400 });
  const out: any[] = [];
  for (const mid of message_ids) {
    const r = await fetch(`https://api.telegram.org/bot${TG}/deleteMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, message_id: mid }),
    });
    const j = await r.json();
    out.push({ message_id: mid, ok: j.ok, error: j.description });
    await new Promise(s => setTimeout(s, 100));
  }
  return new Response(JSON.stringify({ ok: true, results: out }), { headers: { "content-type": "application/json" } });
});
