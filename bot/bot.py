"""
BelFed Analytics — Telegram bot (production, RU-only).

Логика триала: на этапе ранней стадии проекта мы даём 14 дней полного
бесплатного доступа в платный канал — без привязки карты. Пользователь
регистрируется на belfed.ru → автоматически получает trial 14 дней
(триггер в БД) → привязывает Telegram через deep-link → бот выдаёт
одноразовую invite-ссылку в платный канал. Если оплаты по триалу не
было, через 24 часа после конца триала cron telegram-enforce-access
кикает пользователя.

Платная подписка: 1 500 ₽ / мес, авто-продление, карты + SBP.

ENV:
  TELEGRAM_BOT_TOKEN
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
  TELEGRAM_TRADING_CHANNEL_ID    -1003660492325
  TELEGRAM_COMMUNITY_RU_ID       -1003773738299
  TELEGRAM_COMMUNITY_EN_ID       -1003869302680
  BELFED_WEB_URL                 https://belfed.ru
  BOT_SHARED_SECRET              shared secret for bot-claim-trial edge fn
  BOT_CLAIM_TRIAL_URL            optional override, default = SUPABASE_URL/functions/v1/bot-claim-trial
  TELEGRAM_PREVIEW_CHANNEL_URL   optional, public preview channel link to show in welcome
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
# EN community — опциональная env (если не задана, EN-юзеры получают RU-группу как fallback)
_en_id = os.environ.get("TELEGRAM_COMMUNITY_EN_ID", "").strip()
COMMUNITY_EN_ID      = int(_en_id) if _en_id else None
WEB_URL              = os.environ.get("BELFED_WEB_URL", "https://belfed.ru").rstrip("/")
PRICE_RUB            = os.environ.get("PRICE_MONTHLY_RUB", "1500")
BOT_SHARED_SECRET    = os.environ.get("BOT_SHARED_SECRET", "")
BOT_CLAIM_TRIAL_URL  = os.environ.get(
    "BOT_CLAIM_TRIAL_URL",
    f"{SUPABASE_URL}/functions/v1/bot-claim-trial",
)
PREVIEW_CHANNEL_URL  = os.environ.get("TELEGRAM_PREVIEW_CHANNEL_URL", "").strip()

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
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
async def claim_trial_via_edge(telegram_id: int, username: str | None, source: str = "telegram_direct") -> dict | None:
    """Вызывает edge-функцию bot-claim-trial: создаёт lite-профиль и возвращает invite-ссылку."""
    if not BOT_SHARED_SECRET:
        log.error("BOT_SHARED_SECRET is not set; cannot call bot-claim-trial")
        return None
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            r = await client.post(
                BOT_CLAIM_TRIAL_URL,
                headers={
                    "Content-Type": "application/json",
                    "x-bot-secret": BOT_SHARED_SECRET,
                },
                json={
                    "telegram_id": str(telegram_id),
                    "telegram_username": username or "",
                    "source": source,
                },
            )
            try:
                data = r.json()
            except Exception:
                data = None
            if r.status_code >= 500:
                log.error("bot-claim-trial 5xx: %s %s", r.status_code, r.text[:300])
                return None
            return data
    except Exception as e:
        log.error("claim_trial_via_edge failed: %s", e)
        return None

async def get_profile_by_telegram(telegram_id: int) -> dict | None:
    rows = await sb_get(
        "/rest/v1/profiles",
        params={"telegram_id": f"eq.{telegram_id}",
                "select": "id,email,telegram_id,subscription_status,subscription_plan,subscription_expires_at,trial_started_at"},
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
        "Анализируем и работаем на финансовых рынках более 8 лет. "
        "Делимся торговыми идеями, обзорами рынков и аналитикой "
        "от ведущих инвест-домов.\n\n"
        "Акции · Криптовалюты · Сырьё · Валюты\n\n"
        "🎁 14 дней бесплатного доступа — без привязки карты.\n"
        "Зарегистрируйтесь на belfed.ru, привяжите Telegram и зайдите "
        "в закрытый канал.\n\n"
        f"После триала: подписка {PRICE_RUB} ₽ / мес, оплата только по вашему действию, отмена в любой момент."
    ),
    "menu": (
        "// BELFED ANALYTICS\n\n"
        "Рады видеть вас снова, {name}."
    ),
    "trial_active": (
        "🎁 Пробный доступ\n"
        "Действует до: {until}\n"
        "Осталось: {days} дн.\n\n"
        f"Оформить подписку {PRICE_RUB} ₽ / мес: "
        + WEB_URL + "/members.html#subscribe"
    ),
    "status_active":  "✅ Подписка активна\n"
                      f"План: monthly ({PRICE_RUB} ₽ / мес)\n"
                      "Действует до: {until}\n{autorenew}",
    "status_none":    "❌ Подписки нет.\n\n"
                      f"Оформить ({PRICE_RUB} ₽ / мес): " + WEB_URL + "/members.html#subscribe",
    "autorenew_on":   "Автопродление: включено",
    "autorenew_off":  "Автопродление: отключено · доступ закончится в указанную дату",
    "need_link":      "Сначала привяжите аккаунт сайта: " + WEB_URL + "/members.html (кнопка «Привязать Telegram»).",
    "link_already":   "✅ Аккаунт сайта уже привязан к этому Telegram. Откройте /status чтобы посмотреть подписку.",
    "link_ok":        "✅ Telegram привязан. Бесплатный доступ открыт на 14 дней — без привязки карты.",
    "link_bad":       "⚠️ Токен недействителен или истёк. Сгенерируйте новый на сайте.",
    "cancel_ok":      "Автопродление отключено. Доступ сохранится до {until}.",
    "cancel_none":    "У вас нет активной подписки для отмены.",
    "btn_pay":        f"💳 Оформить — {PRICE_RUB} ₽ / мес",
    "btn_paid":       "📺 Платный канал",
    "btn_community":  "💬 Открытое сообщество",
    "btn_status":     "📋 Моя подписка",
    "btn_disclaimer": "⚠️ Disclaimer",
    "btn_link":       "🔗 Привязать аккаунт",
    "no_access":      "Сначала зарегистрируйтесь на " + WEB_URL + " и привяжите Telegram. "
                      "Получите 14 дней бесплатного доступа — без привязки карты.",
    "trial_claim_ok": (
        "🎁 14 дней бесплатного доступа открыты.\n\n"
        "Ваша персональная ссылка в закрытый канал "
        "(одноразовая, действует 24 часа):\n{invite}\n\n"
        f"После триала: подписка {PRICE_RUB} ₽ / мес. "
        "Email понадобится только при первой оплате — для чека."
    ),
    "trial_claim_already_active": (
        "✅ У вас уже есть активный доступ.\n\n"
        "Свежая ссылка в закрытый канал "
        "(одноразовая, действует 24 часа):\n{invite}"
    ),
    "trial_claim_used": (
        "⚠️ Триал на этот Telegram-аккаунт уже был активирован ранее.\n\n"
        "Чтобы продолжить пользоваться сервисом, оформите подписку "
        f"{PRICE_RUB} ₽ / мес: " + WEB_URL + "/members.html#subscribe"
    ),
    "trial_claim_error": (
        "⚠️ Не удалось открыть триал. Попробуйте ещё раз через минуту "
        "или напишите нам на " + WEB_URL + "/members.html"
    ),
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

# ---------- Helpers -------------------------------------------------------
async def grant_paid_invite(context: ContextTypes.DEFAULT_TYPE, telegram_id: int) -> str | None:
    """Выпускает одноразовую invite-ссылку в платный канал, действует 1 час."""
    try:
        # лифт бана если был
        try:
            await context.bot.unban_chat_member(TRADING_CHANNEL_ID, telegram_id, only_if_banned=True)
        except Exception:
            pass
        inv = await context.bot.create_chat_invite_link(
            TRADING_CHANNEL_ID,
            member_limit=1,
            expire_date=int(datetime.now().timestamp()) + 3600,
            name=f"tg:{telegram_id}",
        )
        return inv.invite_link
    except Exception as e:
        log.error("grant_paid_invite failed: %s", e)
        return None

def has_access(profile: dict | None) -> bool:
    if not profile: return False
    if profile.get("subscription_status") == "admin": return True
    exp = parse_ts(profile.get("subscription_expires_at"))
    return bool(exp and exp > datetime.now(timezone.utc))

def is_admin(profile: dict | None) -> bool:
    return bool(profile and profile.get("subscription_status") == "admin")

# ---------- Handlers ------------------------------------------------------
async def cmd_start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    args = context.args or []

    # Deep-link /start trial — рекламная воронка без регистрации
    # Форматы: "trial", "trial_<utm_source>" (для атрибуции рекламы)
    if args and (args[0] == "trial" or args[0].startswith("trial_")):
        source = args[0]  # сохраним как trial_source для атрибуции
        res = await claim_trial_via_edge(user.id, user.username, source=source)
        if res is None:
            await update.message.reply_text(TEXTS["trial_claim_error"])
            await send_main_menu(update, context)
            return

        if res.get("ok"):
            invite = res.get("invite_link") or "—"
            if res.get("already_active"):
                await update.message.reply_text(
                    TEXTS["trial_claim_already_active"].format(invite=invite),
                    disable_web_page_preview=True,
                )
            else:
                await update.message.reply_text(
                    TEXTS["trial_claim_ok"].format(invite=invite),
                    disable_web_page_preview=True,
                )
        else:
            err = res.get("error")
            if err == "trial_already_used":
                await update.message.reply_text(TEXTS["trial_claim_used"])
            else:
                log.warning("claim_trial returned error: %s", res)
                await update.message.reply_text(TEXTS["trial_claim_error"])
        await send_main_menu(update, context)
        return

    # Deep-link /start <token>
    if args and len(args[0]) >= 16:
        token = args[0]
        status, _ = await sb_post(
            "/rest/v1/rpc/claim_telegram_link",
            {"p_token": token, "p_telegram_id": user.id, "p_username": user.username or ""},
        )
        if status in (200, 201):
            # сначала берём профиль, чтобы понимать роль и правильно поздравить
            profile = await get_profile_by_telegram(user.id)
            if is_admin(profile):
                await update.message.reply_text("✅ Telegram привязан. Доступ администратора.")
            else:
                await update.message.reply_text(TEXTS["link_ok"])
            # сразу выдаём invite в платный канал, если есть доступ (триал/подписка/админ)
            if has_access(profile):
                link = await grant_paid_invite(context, user.id)
                if link:
                    await update.message.reply_text(
                        "📺 Ваша персональная ссылка в закрытый канал "
                        "(действует 1 час, одноразовая):\n" + link,
                        disable_web_page_preview=True,
                    )
        else:
            await update.message.reply_text(TEXTS["link_bad"])
        await send_main_menu(update, context)
        return

    await send_main_menu(update, context)

async def send_main_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    profile = await get_profile_by_telegram(user.id)

    # Открытое сообщество — для всех
    try:
        inv = await context.bot.create_chat_invite_link(
            COMMUNITY_RU_ID, member_limit=1,
            expire_date=int(datetime.now().timestamp()) + 3600,
        )
        community_url = inv.invite_link
    except Exception as e:
        log.error("community invite failed: %s", e)
        community_url = f"{WEB_URL}/members.html"

    rows = [[InlineKeyboardButton(TEXTS["btn_community"], url=community_url)]]

    # Кнопка платного канала — только если есть доступ
    if has_access(profile):
        rows.append([InlineKeyboardButton(TEXTS["btn_paid"],   callback_data="paid_invite")])

    rows.append([InlineKeyboardButton(TEXTS["btn_status"],     callback_data="sub_status")])

    # Кнопка «Оформить» — только если нет активной платной подписки и не админ
    sub = await get_subscription(profile["id"]) if profile else None
    has_active_paid = sub and sub.get("status") == "active"
    if not has_active_paid and not is_admin(profile):
        rows.append([InlineKeyboardButton(TEXTS["btn_pay"],    url=f"{WEB_URL}/members.html#subscribe")])
    if not profile:
        rows.append([InlineKeyboardButton(TEXTS["btn_link"],   url=f"{WEB_URL}/members.html#link")])
    rows.append([InlineKeyboardButton(TEXTS["btn_disclaimer"], callback_data="disclaimer")])

    text = TEXTS["menu"].format(name=user.first_name or "") if profile \
           else TEXTS["welcome_new"].format(name=user.first_name or "")

    target = update.callback_query.message if update.callback_query else update.message
    await target.reply_text(text, reply_markup=InlineKeyboardMarkup(rows))

async def cmd_link(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    profile = await get_profile_by_telegram(user.id)
    if profile:
        await update.message.reply_text(TEXTS["link_already"])
    else:
        await update.message.reply_text(TEXTS["need_link"])

async def cmd_status(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    profile = await get_profile_by_telegram(user.id)
    if not profile:
        await update.message.reply_text(TEXTS["need_link"])
        return

    sub = await get_subscription(profile["id"])
    exp = parse_ts(profile.get("subscription_expires_at"))
    now = datetime.now(timezone.utc)
    plan = profile.get("subscription_plan")

    if is_admin(profile):
        msg = "✅ Администратор. Доступ ко всем материалам без ограничений."
    elif sub and sub.get("status") == "active" and exp and exp > now:
        # Автопродление включено только если есть payment_method_id (рекуррент сохранён)
        # И пользователь не отменил его через cancel_at_period_end.
        has_pm = bool(sub.get("payment_method_id"))
        autorenew = (TEXTS["autorenew_on"]
                     if has_pm and not sub.get("cancel_at_period_end")
                     else TEXTS["autorenew_off"])
        msg = TEXTS["status_active"].format(until=exp.strftime("%d.%m.%Y"), autorenew=autorenew)
    elif plan == "trial" and exp and exp > now:
        days_left = max(0, (exp - now).days)
        msg = TEXTS["trial_active"].format(until=exp.strftime("%d.%m.%Y"), days=days_left)
    else:
        msg = TEXTS["status_none"]

    await update.message.reply_text(msg, disable_web_page_preview=True)

async def cmd_cancel(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    profile = await get_profile_by_telegram(user.id)
    if not profile:
        await update.message.reply_text(TEXTS["need_link"]); return

    sub = await get_subscription(profile["id"])
    if not sub or sub.get("status") != "active":
        await update.message.reply_text(TEXTS["cancel_none"]); return

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

    if query.data == "paid_invite":
        profile = await get_profile_by_telegram(user.id)
        if not has_access(profile):
            await query.message.reply_text(TEXTS["no_access"], disable_web_page_preview=True)
            return
        link = await grant_paid_invite(context, user.id)
        if link:
            await query.message.reply_text(
                "📺 Ваша ссылка в закрытый канал (1 час, одноразовая):\n" + link,
                disable_web_page_preview=True,
            )
        else:
            await query.message.reply_text("⚠️ Не удалось создать ссылку. Проверьте, что бот — администратор канала.")
        return

    if query.data == "sub_status":
        # повторяем cmd_status для callback
        profile = await get_profile_by_telegram(user.id)
        if not profile:
            await query.message.reply_text(TEXTS["need_link"]); return
        sub = await get_subscription(profile["id"])
        exp = parse_ts(profile.get("subscription_expires_at"))
        now = datetime.now(timezone.utc)
        plan = profile.get("subscription_plan")
        if sub and sub.get("status") == "active" and exp and exp > now:
            has_pm = bool(sub.get("payment_method_id"))
            autorenew = (TEXTS["autorenew_on"]
                         if has_pm and not sub.get("cancel_at_period_end")
                         else TEXTS["autorenew_off"])
            msg = TEXTS["status_active"].format(until=exp.strftime("%d.%m.%Y"), autorenew=autorenew)
        elif plan == "trial" and exp and exp > now:
            days_left = max(0, (exp - now).days)
            msg = TEXTS["trial_active"].format(until=exp.strftime("%d.%m.%Y"), days=days_left)
        else:
            msg = TEXTS["status_none"]
        await query.message.reply_text(msg, disable_web_page_preview=True)
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
    log.info("BelFed bot (RU, single plan + trial) running")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()
