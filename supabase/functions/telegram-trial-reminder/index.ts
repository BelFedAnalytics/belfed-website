// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: telegram-trial-reminder
// Cron: every 6h. Sends a "trial ends tomorrow" DM to users whose
// subscription_expires_at is between now+6h and now+36h, and they're on
// 'trial' plan and have a linked telegram_id and not yet reminded.
//
// CRON: 15 */6 * * *  POST  Authorization: Bearer <SERVICE_ROLE_KEY>
//
// SECRETS:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_TOKEN
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TG_TOKEN         = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const WEB_URL          = Deno.env.get("BELFED_WEB_URL") ?? "https://belfed.ru";

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

  const { data: list, error } = await admin
    .from("users_for_trial_reminder")
    .select("*")
    .limit(500);
  if (error) return new Response(error.message, { status: 500 });

  const results: any[] = [];
  for (const row of list ?? []) {
    try {
      const ends = new Date(row.subscription_expires_at).toLocaleDateString("ru-RU", {
        day: "2-digit", month: "long",
      });
      const text =
        "⏰ Ваш пробный доступ к BelFed Analytics заканчивается " + ends + ".\n\n" +
        "Оформите подписку 1 500 ₽ / мес, чтобы продолжить получать торговые идеи, " +
        "техническую аналитику и оставаться в закрытом канале:\n" +
        WEB_URL + "/members.html#subscribe\n\n" +
        "Без подписки доступ в платный канал автоматически закроется.";
      const r: any = await tg("sendMessage", {
        chat_id: Number(row.telegram_id),
        text,
        disable_web_page_preview: true,
      });
      await admin.from("profiles").update({
        trial_reminder_sent_at: new Date().toISOString(),
      }).eq("id", row.user_id);
      results.push({ user: row.user_id, ok: !!r?.ok });
    } catch (e) {
      results.push({ user: row.user_id, ok: false, error: (e as Error).message });
    }
  }

  return new Response(JSON.stringify({ processed: results.length, results }),
    { headers: { "Content-Type": "application/json" } });
});
