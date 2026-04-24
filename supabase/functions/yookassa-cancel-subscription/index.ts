// deno-lint-ignore-file no-explicit-any
// Supabase Edge Function: yookassa-cancel-subscription
// Called by the website (authenticated user) OR the Telegram bot (service role)
// to stop auto-renewal. YooKassa does not delete saved payment methods itself —
// we simply stop using payment_method_id for future charges.
//
// Access remains valid until current_period_end — we only set
// cancel_at_period_end = true. The cron (telegram-enforce-access) kicks the
// user after subscription_expires_at passes.
//
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL     = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY         = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });

  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: u, error: userErr } = await userClient.auth.getUser();
  if (userErr || !u?.user) return json({ error: "unauthorized" }, 401);

  const body = await req.json().catch(() => ({} as any));
  const reason: string = (body?.reason ?? "user_requested").slice(0, 200);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const { data: sub, error: subErr } = await admin
    .from("subscriptions")
    .select("id, status, current_period_end")
    .eq("user_id", u.user.id)
    .maybeSingle();
  if (subErr) return json({ error: "db_error", detail: subErr.message }, 500);
  if (!sub)   return json({ error: "no_subscription" }, 404);

  await admin.from("subscriptions").update({
    cancel_at_period_end: true,
    cancel_reason: reason,
    canceled_at:   new Date().toISOString(),
    updated_at:    new Date().toISOString(),
  }).eq("id", sub.id);

  return json({
    ok: true,
    access_until: sub.current_period_end,
    message: "Auto-renewal cancelled. Your access remains until current_period_end.",
  });
});
