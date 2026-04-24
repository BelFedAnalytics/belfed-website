// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: telegram-link-start
// Called by the website — generates a single-use token and returns a deep link:
//   https://t.me/<bot>?start=<token>
// The user taps it, Telegram opens a chat with the bot, and the bot auto-sends
// /start <token> which triggers claim_telegram_link() RPC in Postgres.
//
// REQUIRED SECRETS:
//   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//   TELEGRAM_BOT_USERNAME  e.g. "BelfedBot"
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_USERNAME     = Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "BelfedBot";

const cors = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

function randomToken(bytes = 18) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405, headers: cors });

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: u, error } = await userClient.auth.getUser();
  if (error || !u?.user) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const token = randomToken();

  const { error: insErr } = await admin.from("telegram_link_tokens").insert({
    token,
    user_id: u.user.id,
    direction: "site_to_bot",
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  });
  if (insErr) return json({ error: "db_error", detail: insErr.message }, 500);

  return json({
    token,
    deep_link: `https://t.me/${BOT_USERNAME}?start=${token}`,
    expires_in_seconds: 15 * 60,
  });
});
