"""
BelFed Analytics — Telegram bot (production, RU-only).

Этот bot обслуживает только русскоязычную аудиторию. Оплаты принимаются
через ЮKassa, только рубли и российские карты. EN-версия будет добавлена
отдельным PR позднее.

Обязанности:
1. Онбординг (приветствие, дисклеймер, пробный период).
2. Привязка Telegram-аккаунта к профилю Supabase через deep-link
   (https://t.me/BelfedBot?start=<token>).
3. Чтение статуса подписки из Supabase.
4. Выдача одноразовых invite-ссылок в платный канал только активным
   подписчикам / пользователям с пробным доступом.
5. /cancel — отмена автопродления.

Переменные окружения:
  TELEGRAM_BOT_TOKEN
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE_KEY
  TELEGRAM_TRADING_CHANNEL_ID   например -1003660492325
  TELEGRAM_COMMUNITY_RU_ID
  BELFED_WEB_URL                https://belfed.ru
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone

import httpx
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import (
    Application, CommandHandler, CallbackQueryHandler, ContextTypes,
)

# ---------- Config ---------------------------------------------------------
BOT_TOKEN            = os.environ["TELEGRAM_BOT_TOKEN"]
SUPABASE_URL         = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
TRADING_CHANNEL_ID   = int(os.environ["TELEGRAM_TRADING_CHANNEL_ID"])
COMMUNITY_RU_ID      = int(os.environ["TELEGRAM_COMMUNITY_RU_ID"])
WEB_URL              = os.environ.get("BELFED_WEB_URL", "https://belfed.ru").rstrip("/")

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
log = logging.getLogger("belfed-bot")

# ---------- Supabase REST helpers -----------------------------------------
SB_HEADERS = {
    "apikey":        SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type":  "application/json",
}

async def sb_get(path: str, params: dict | None = None):
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{SUPABASE_URL}{path}", headers=SB_HEADERS, params=params or {})
        if r.status_code == 200:
            return r.json()
        log.warning("sb_get %s %s -> %s %s", path, params, r.status_code, r.text[:200])
        return None

async def sb_post(path: str, body: dict):
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.post(f"{SUPABASE_URL}{path}", headers=SB_HEADERS, json=body)
        try: data = r.json()
        except Exception: data = None
        return r.status_code, data

async def sb_patch(path: str, params: dict, body: dict) -> int:
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.patch(
            f"{SUPABASE_URL}{path}",
            headers={**SB_HEADERS, "Prefer": "return=minimal"},
            params=params, json=body,
        )
        return r.status_code

# ---------- Data access ---------------------------------------------------
async def get_profile_by_telegram(telegram_id: int) -> dict | None:
    rows = await sb_get(
        "/rest/v1/profiles",
        params={"telegram_id": f"eq.{telegram_id}",
                "select": "id,telegram_id,subscription_plan,subscription_expires_at"},
    )
    return rows[0] if rows else None

async def get_subscription(user_id: str) -> dict | None:
    rows = await sb_get(
        "/rest/v1/subscriptions",
        params={"user_id": f"eq.{user_id}",
                "select": "status,plan_code,current_period_end,cancel_at_period_end,payment_method_id"},
    )
    return rows[0] if rows else None

def parse_ts(s: str | None):
    if not s: return None
    try: return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception: return None

# ---------- UI тексты ----------------------------------------------------
TEXTS = {
    "welcome_new": (
        "// BELFED ANALYTICS · EST. 2025\n\n"
        "Добро пожаловать, {name}.\n\n"
        "Мы анализируем и работаем на финансовых рынках более 8 лет. "
        "Делимся торговыми идеями, обзорами рынков и аналитикой "
        "от ведущих инвест-домов.\n\n"
        "Акции · Криптовалюты · Сырьё · Валюты\n\n"
        "// РЕЗУЛЬТАТЫ 2025 · belfed.ru\n"
        "📊 Акции  +85.96R · 47.89% · 71 идея\n"
        "📊 Крипто +87.00R · 75.00% · 12 идей\n\n"
        "Чтобы получить доступ к платному каналу — оформите подписку "
        "или привяжите аккаунт сайта.\n\n"
        "🎁 Пробный доступ к сообществу до: {trial}"
    ),
    "menu": (
        "// BELFED ANALYTICS\n\n"
        "Рады видеть вас снова, {name}.\n\n"
        "Торговые идеи, аналитика и обсуждения по акциям, крипто, "
        "сырью и валютам — всё здесь."
    ),
    "status_active":  "✅ Подписка активна\nПлан: {plan}\nДействует до: {until}\n{autorenew}",
    "status_trial":   "🎁 Пробный период\nДействует до: {until}",
    "status_none":    "❌ Подписки нет.\n\nОформить: {url}/members.html",
    "autorenew_on":   "Автопродление: включено",
    "autorenew_off":  "Автопродление: отключено",
    "need_link":      "Сначала привяжите аккаунт сайта: {url}/members.html (кнопка «Привязать Telegram»).",
    "link_ok":        "✅ Аккаунт привязан. Теперь можно оформить подписку на сайте.",
    "link_bad":       "⚠️ Токен недействителен или истёк. Сгенерируйте новый на сайте.",
    "cancel_ok":      "Автопродление отключено. Доступ сохранится до {until}.",
    "cancel_none":    "У вас нет активной подписки для отмены.",
    "btn_pay":        "💳 Оформить подписку",
    "btn_community":  "💬 Войти в сообщество",
    "btn_status":     "📋 Моя подписка",
    "btn_disclaimer": "⚠️ Disclaimer",
    "btn_link":       "🔗 Привязать аккаунт сайта",
    "disclaimer": (
        "// DISCLAIMER\n"
        "────────────────────────\n\n"
        "Вся информация публикуется исключительно в образовательных "
        "и аналитических целях.\n\n"
        "Не является финансовой консультацией или инвестиционной "
        "рекомендацией.\n\n"
        "Торговля финансовыми инструментами сопряжена с риском. "
        "Вы самостоятельно несёте ответственность за свои торговые "
        "решения и управление капиталом.\n\n"
        "Прошлые результаты не гарантируют доходности в будущем.\n\n"
        "belfed.ru\n"
        "────────────────────────"
    ),
}

# ---------- Handlers ------------------------------------------------------
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    args = context.args or []

    # Deep-link: /start <token> — привязка аккаунта
    if args and len(args[0]) >= 16:
        token = args[0]
        status, _ = await sb_post(
            "/rest/v1/rpc/claim_telegram_link",
            {"p_token": token, "p_telegram_id": user.id, "p_username": user.username or ""},
        )
        if status in (200, 201):
            await update.message.reply_text(TEXTS["link_ok"])
        else:
            await update.message.reply_text(TEXTS["link_bad"])
        await send_main_menu(update, context)
        return

    await send_main_menu(update, context)

async def send_main_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    profile = await get_profile_by_telegram(user.id)

    # Ссылка в открытое сообщество (для всех, ограничение 1 использование, 1 час)
    try:
        inv = await context.bot.create_chat_invite_link(
            COMMUNITY_RU_ID, member_limit=1,
            expire_date=int(datetime.now().timestamp()) + 3600,
        )
        community_url = inv.invite_link
    except Exception as e:
        log.error("community invite failed: %s", e)
        community_url = f"{WEB_URL}/members.html"

    rows = [
        [InlineKeyboardButton(TEXTS["btn_community"],  url=community_url)],
        [InlineKeyboardButton(TEXTS["btn_status"],     callback_data="sub_status")],
        [InlineKeyboardButton(TEXTS["btn_pay"],        url=f"{WEB_URL}/members.html#subscribe")],
        [InlineKeyboardButton(TEXTS["btn_link"],       url=f"{WEB_URL}/members.html#link")],
        [InlineKeyboardButton(TEXTS["btn_disclaimer"], callback_data="disclaimer")],
    ]

    if profile:
        text = TEXTS["menu"].format(name=user.first_name or "")
    else:
        trial_end = (datetime.now() + timedelta(days=14)).strftime("%d.%m.%Y")
        text = TEXTS["welcome_new"].format(name=user.first_name or "", trial=trial_end)

    target = update.callback_query.message if update.callback_query else update.message
    await target.reply_text(text, reply_markup=InlineKeyboardMarkup(rows))

async def cmd_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(TEXTS["need_link"].format(url=WEB_URL))

async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    profile = await get_profile_by_telegram(user.id)
    if not profile:
        await update.message.reply_text(TEXTS["need_link"].format(url=WEB_URL))
        return

    sub = await get_subscription(profile["id"])
    exp = parse_ts(profile.get("subscription_expires_at"))
    now = datetime.now(timezone.utc)

    if sub and sub.get("status") == "active" and exp and exp > now:
        autorenew = TEXTS["autorenew_off"] if sub.get("cancel_at_period_end") else TEXTS["autorenew_on"]
        msg = TEXTS["status_active"].format(
            plan=sub.get("plan_code") or "—",
            until=exp.strftime("%d.%m.%Y"),
            autorenew=autorenew,
        )
    elif exp and exp > now:
        msg = TEXTS["status_trial"].format(until=exp.strftime("%d.%m.%Y"))
    else:
        msg = TEXTS["status_none"].format(url=WEB_URL)

    await update.message.reply_text(msg)

async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    profile = await get_profile_by_telegram(user.id)
    if not profile:
        await update.message.reply_text(TEXTS["need_link"].format(url=WEB_URL))
        return

    sub = await get_subscription(profile["id"])
    if not sub or sub.get("status") != "active":
        await update.message.reply_text(TEXTS["cancel_none"])
        return

    await sb_patch(
        "/rest/v1/subscriptions",
        params={"user_id": f"eq.{profile['id']}"},
        body={
            "cancel_at_period_end": True,
            "cancel_reason": "user_requested_via_bot",
            "canceled_at":   datetime.now(timezone.utc).isoformat(),
            "updated_at":    datetime.now(timezone.utc).isoformat(),
        },
    )
    exp = parse_ts(sub.get("current_period_end")) or datetime.now(timezone.utc)
    await update.message.reply_text(TEXTS["cancel_ok"].format(until=exp.strftime("%d.%m.%Y")))

async def on_button(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    user = query.from_user

    if query.data == "sub_status":
        profile = await get_profile_by_telegram(user.id)
        if not profile:
            await query.message.reply_text(TEXTS["need_link"].format(url=WEB_URL))
            return
        sub = await get_subscription(profile["id"])
        exp = parse_ts(profile.get("subscription_expires_at"))
        now = datetime.now(timezone.utc)
        if sub and sub.get("status") == "active" and exp and exp > now:
            autorenew = TEXTS["autorenew_off"] if sub.get("cancel_at_period_end") else TEXTS["autorenew_on"]
            msg = TEXTS["status_active"].format(
                plan=sub.get("plan_code") or "—",
                until=exp.strftime("%d.%m.%Y"),
                autorenew=autorenew,
            )
        elif exp and exp > now:
            msg = TEXTS["status_trial"].format(until=exp.strftime("%d.%m.%Y"))
        else:
            msg = TEXTS["status_none"].format(url=WEB_URL)
        await query.message.reply_text(msg)
        return

    if query.data == "disclaimer":
        await query.message.reply_text(TEXTS["disclaimer"])

async def on_error(update: object, context: ContextTypes.DEFAULT_TYPE):
    log.exception("unhandled error", exc_info=context.error)

def main():
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start",  cmd_start))
    app.add_handler(CommandHandler("link",   cmd_link))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(CommandHandler("cancel", cmd_cancel))
    app.add_handler(CallbackQueryHandler(on_button))
    app.add_error_handler(on_error)
    log.info("BelFed bot (RU) running")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
