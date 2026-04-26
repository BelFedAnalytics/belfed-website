// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: telegram-enforce-access
// Scheduled cron: every 6 hours. Kicks users from the paid Telegram channel
// whose subscription_expires_at is more than 24h in the past.
//
// CRON: 0 */6 * * *  POST  Authorization: Bearer <SERVICE_ROLE_KEY>
//
// REQUIRED SECRETS:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN
//   TELEGRAM_PAID_CHAT_ID
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TG_TOKEN         = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const PAID_CHAT_ID     = Number(Deno.env.get("TELEGRAM_PAID_CHAT_ID")!);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

async function tg(method: string, body: Record<string, any>) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await r.json().catch(() => ({ ok: false }));
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const { data: toKick, error } = await admin
    .from("telegram_users_to_kick")
    .select("*")
    .limit(200);
  if (error) return new Response(error.message, { status: 500 });

  const results: any[] = [];
  for (const row of toKick ?? []) {
    try {
      // banChatMember + immediate unban = kick without permanent ban
      const ban: any = await tg("banChatMember", {
        chat_id: PAID_CHAT_ID, user_id: Number(row.telegram_id),
      });
      await tg("unbanChatMember", {
        chat_id: PAID_CHAT_ID, user_id: Number(row.telegram_id), only_if_banned: true,
      });

      // Friendly DM (best-effort)
      await tg("sendMessage", {
        chat_id: Number(row.telegram_id),
        text:
          "Ваша подписка BelFed Analytics истекла.\n" +
          "Продлить можно в личном кабинете: https://belfed.ru/members.html",
      });

      await admin.from("telegram_access_log").insert({
        user_id: row.user_id,
        telegram_id: row.telegram_id,
        chat_id: PAID_CHAT_ID,
        action: "kick",
        result: ban?.ok ? "ok" : "error",
        detail: JSON.stringify(ban).slice(0, 500),
      });
      results.push({ user: row.user_id, ok: !!ban?.ok });
    } catch (e) {
      const msg = (e as Error).message;
      await admin.from("telegram_access_log").insert({
        user_id: row.user_id, telegram_id: row.telegram_id,
        chat_id: PAID_CHAT_ID, action: "kick", result: "error", detail: msg.slice(0, 500),
      });
      results.push({ user: row.user_id, ok: false, error: msg });
    }
  }
  return new Response(JSON.stringify({ processed: results.length, results }),
    { headers: { "Content-Type": "application/json" } });
});
