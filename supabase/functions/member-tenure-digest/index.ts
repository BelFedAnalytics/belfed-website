// member-tenure-digest v1 — ежедневное уведомление админам о месячных отметках
// подписки действующих участников.
//
// Читает public.member_tenure_status, берёт тех, у кого сегодня наступила
// очередная месячная отметка от даты первого платежа, и присылает одно
// сообщение в Telegram: сколько месяцев исполнилось, общий стаж, план, язык,
// число платежей и дата окончания текущего периода. Каждая отметка
// фиксируется в public.member_tenure_notices, поэтому повторно не приходит.
//
// Ручной вызов:
//   POST {}                     — обычный прогон за сегодня
//   POST { "roster": true }     — полный список действующих подписчиков со стажем
//   POST { "dry_run": true }    — собрать текст, ничего не отправляя и не помечая
//
// SECRETS: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN,
//          ADMIN_TELEGRAM_IDS (необязательно, по умолчанию 118296372)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TG_TOKEN     = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const ADMIN_TG_IDS: number[] = (Deno.env.get("ADMIN_TELEGRAM_IDS") ?? "118296372")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type Row = {
  profile_id: string;
  lang: string | null;
  email: string | null;
  telegram_id: string | number | null;
  telegram_username: string | null;
  founding_member: boolean | null;
  subscription_plan: string | null;
  subscription_expires_at: string | null;
  first_paid: string;
  payments_count: number;
  tenure_days: number;
  months_elapsed: number;
  anniversary_today: boolean;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

async function sendTg(chatId: number, text: string): Promise<boolean> {
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const body = await r.json().catch(() => ({}));
    if (!body?.ok) console.error("sendMessage failed", chatId, JSON.stringify(body));
    return Boolean(body?.ok);
  } catch (e) {
    console.error("sendMessage error", chatId, String(e));
    return false;
  }
}

function who(r: Row): string {
  if (r.telegram_username) return "@" + r.telegram_username;
  if (r.email) return r.email;
  if (r.telegram_id) return "tg:" + r.telegram_id;
  return r.profile_id.slice(0, 8);
}

function fmtDate(d: string | null): string {
  if (!d) return "-";
  const [y, m, day] = d.slice(0, 10).split("-");
  return `${day}.${m}.${y}`;
}

function tenure(r: Row): string {
  const months = r.months_elapsed;
  if (months < 1) return `${r.tenure_days} дн.`;
  return `${months} мес. (${r.tenure_days} дн.)`;
}

function line(r: Row): string {
  const tags = [
    r.founding_member ? "FM" : "обычная",
    (r.lang ?? "ru").toUpperCase(),
    r.subscription_plan ?? "-",
  ].join(" · ");
  return [
    `${who(r)} — ${tenure(r)}`,
    `   ${tags}`,
    `   с ${fmtDate(r.first_paid)}, платежей ${r.payments_count}, оплачено до ${fmtDate(r.subscription_expires_at)}`,
  ].join("\n");
}

Deno.serve(async (req) => {
  let opts: { roster?: boolean; dry_run?: boolean } = {};
  try {
    opts = await req.json();
  } catch { /* пустое тело — обычный прогон */ }

  const { data, error } = await admin
    .from("member_tenure_status")
    .select("*")
    .order("first_paid", { ascending: true });

  if (error) return json({ ok: false, error: error.message }, 500);
  const rows = (data ?? []) as Row[];

  // Полный список по запросу: без пометок в журнале.
  if (opts.roster) {
    const text = [
      `📋 Действующие подписки: ${rows.length}`,
      "",
      ...rows.map(line),
    ].join("\n");
    if (!opts.dry_run) for (const id of ADMIN_TG_IDS) await sendTg(id, text);
    return json({ ok: true, mode: "roster", count: rows.length, text });
  }

  const due = rows.filter((r) => r.anniversary_today && r.months_elapsed >= 1);
  if (due.length === 0) return json({ ok: true, mode: "daily", due: 0 });

  // Отсекаем уже отправленные отметки.
  const { data: sent } = await admin
    .from("member_tenure_notices")
    .select("profile_id, months")
    .in("profile_id", due.map((r) => r.profile_id));
  const seen = new Set((sent ?? []).map((s) => `${s.profile_id}:${s.months}`));
  const fresh = due.filter((r) => !seen.has(`${r.profile_id}:${r.months_elapsed}`));
  if (fresh.length === 0) return json({ ok: true, mode: "daily", due: due.length, fresh: 0 });

  const head = fresh.length === 1
    ? "📅 Месячная отметка подписки"
    : `📅 Месячные отметки подписки: ${fresh.length}`;
  const text = [head, "", ...fresh.map(line)].join("\n");

  if (opts.dry_run) return json({ ok: true, mode: "dry_run", fresh: fresh.length, text });

  let delivered = 0;
  for (const id of ADMIN_TG_IDS) if (await sendTg(id, text)) delivered++;

  if (delivered > 0) {
    const { error: insErr } = await admin
      .from("member_tenure_notices")
      .upsert(
        fresh.map((r) => ({ profile_id: r.profile_id, months: r.months_elapsed })),
        { onConflict: "profile_id,months" },
      );
    if (insErr) console.error("notices upsert failed", insErr.message);
  }

  return json({ ok: true, mode: "daily", fresh: fresh.length, delivered });
});
