# BelFed — интеграция платежей ЮKassa (RU only)

Полная настройка платной подписки в Telegram с автопродлением, чеками 54-ФЗ,
выдачей доступа и отменой. EN-версия будет добавлена отдельным PR.

> Все платежи принимаются только в рублях и только российскими картами
> (Мир, Visa/MC РФ-эмиссии), SBP, YooMoney, SberPay, Tinkoff Pay.
> Поэтому весь платный UI живёт только на **belfed.ru**. Сайт belfed.com
> в этом PR не меняется.

---

## Архитектура

```
 Сайт belfed.ru/members.html
   │ 1. Кнопка «Оформить» (belfed-payments.js)
   ▼
 Supabase Edge: yookassa-create-payment
   │ api.yookassa.ru (save_payment_method=true, receipt)
   ▼
 Платёжная форма ЮKassa (пользователь оплачивает)
   │
   ▼
 ЮKassa → HTTP-уведомление → Supabase Edge: yookassa-webhook
   │  - проверка IP ЮKassa (CIDR allowlist)
   │  - дедупликация по payment_events
   │  - RPC apply_successful_payment  → продлевает profiles.subscription_expires_at
   │  - upsert subscriptions с payment_method_id
   │  - DM пользователю с одноразовой ссылкой в платный канал
   ▼
 Cron (каждые 6 ч): yookassa-charge-recurring
   │ списывает с сохранённого payment_method_id
 Cron (каждые 6 ч): telegram-enforce-access
   │ кикает пользователей через 24 ч после истечения доступа
 /cancel (bot) или кнопка на сайте
   │ subscriptions.cancel_at_period_end = true
```

Пользователь остаётся в канале до конца оплаченного периода.
После истечения + 24 ч grace-period `telegram-enforce-access` кикает
его с DM о продлении.

---

## Шаг 0 — Предусловия

- Магазин ЮKassa полностью верифицирован, работает **по API-протоколу**
  (в кабинете → Магазин; если поля «протокол» нет — напишите в поддержку
  с указанием ShopID).
- Подключена касса (ФН) / чеки ЮKassa / ОФД — чеки 54-ФЗ обязательны.
- Менеджер ЮKassa **включил автоплатежи** на боевом магазине.
  На тестовом они работают по умолчанию.
- Бот (`@BelfedBot`) — **администратор** платного канала и
  RU-сообщества, с правами *Приглашать пользователей* и *Банить*.

---

## Шаг 1 — Перевыпуск токена бота

Текущий `bot.py` содержал токен в открытом виде. Его надо перевыпустить:

1. `@BotFather` → `/mybots` → BelfedBot → `API Token` → **Revoke current token**.
2. Новый токен положите в Supabase Edge Secrets и в env хостинга бота.

---

## Шаг 2 — Миграция БД

Файл: `supabase/migrations/20260424_002_access_and_rpcs.sql`

Supabase Dashboard → **SQL Editor → New query** → вставить весь файл → Run.
Миграция идемпотентна.

---

## Шаг 3 — Секреты Edge Functions

Supabase Dashboard → **Project Settings → Edge Functions → Secrets**:

| Ключ | Значение |
|---|---|
| `YOOKASSA_MODE` | `test` (переключить на `live` после теста) |
| `YOOKASSA_TEST_SHOP_ID` / `YOOKASSA_TEST_SECRET_KEY` | из тестового магазина |
| `YOOKASSA_SHOP_ID` / `YOOKASSA_SECRET_KEY` | из боевого магазина |
| `YOOKASSA_RETURN_URL` | `https://belfed.ru/members.html?payment=return` |
| `YOOKASSA_VAT_CODE` | `1` (без НДС — УСН) |
| `YOOKASSA_TAX_SYSTEM` | `2` (УСН доходы) — опционально |
| `TELEGRAM_BOT_TOKEN` | новый токен из шага 1 |
| `TELEGRAM_BOT_USERNAME` | `BelfedBot` (без @) |
| `TELEGRAM_PAID_CHAT_ID` | `-1003660492325` |

`SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
подставляются автоматически.

---

## Шаг 4 — Деплой Edge Functions

```bash
supabase link --project-ref obujqvqqmyfcfflhqvud

# webhook принимает анонимные POST от ЮKassa:
supabase functions deploy yookassa-webhook --no-verify-jwt

# cron вызываются с bearer service-role, JWT-проверка нужна:
supabase functions deploy yookassa-create-payment
supabase functions deploy yookassa-cancel-subscription
supabase functions deploy yookassa-charge-recurring
supabase functions deploy telegram-link-start
supabase functions deploy telegram-enforce-access
```

---

## Шаг 5 — HTTP-уведомления ЮKassa

Кабинет ЮKassa → **Интеграция → HTTP-уведомления**. URL:

```
https://obujqvqqmyfcfflhqvud.supabase.co/functions/v1/yookassa-webhook
```

События:
- `payment.succeeded`
- `payment.canceled`
- `refund.succeeded`

Сохранить. Проверочный ping должен вернуть **HTTP 200**.

---

## Шаг 6 — Cron-задачи

Supabase → **Edge Functions → Cron**:

| Имя | Расписание (UTC) | Функция | Method | Header |
|---|---|---|---|---|
| `charge-recurring` | `0 */6 * * *` | `yookassa-charge-recurring` | POST | `Authorization: Bearer <SERVICE_ROLE_KEY>` |
| `enforce-access` | `30 */6 * * *` | `telegram-enforce-access` | POST | `Authorization: Bearer <SERVICE_ROLE_KEY>` |

---

## Шаг 7 — Подключение на сайте belfed.ru

1. Скопируйте `website/belfed-subscription.js` в корень репо рядом с
   `belfed-payments.js`.
2. В `members.html` в блок «Подписка» добавьте:

```html
<div class="account-section" style="max-width:1060px;">
  <h2>// Подписка</h2>
  <div id="belfedSubscriptionBox"></div>
  <div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:16px;">
    <button data-plan="month"   class="login-btn" style="width:auto;padding:14px 22px;">1 месяц — 2 990 ₽</button>
    <button data-plan="quarter" class="login-btn" style="width:auto;padding:14px 22px;">3 месяца — 7 990 ₽</button>
    <button data-plan="year"    class="login-btn" style="width:auto;padding:14px 22px;">12 месяцев — 24 990 ₽</button>
  </div>
  <p id="payStatus" style="margin-top:12px;font-size:12px;color:var(--gray);"></p>
</div>

<script src="belfed-auth.js"></script>
<script src="belfed-payments.js"></script>
<script src="belfed-subscription.js"></script>
<script>
  document.querySelectorAll('[data-plan]').forEach(btn => {
    window.BelfedPayments.bindButton(btn, { plan: btn.dataset.plan });
  });
</script>
```

3. CSP на `members.html` должен разрешать `connect-src https://*.supabase.co`
   (уже разрешено).

> `belfed.com` в этом PR не изменяется. EN-интерфейс и платежи
> будут добавлены отдельно, когда определитесь с международным
> провайдером (Stripe / Paddle / и т.п.).

---

## Шаг 8 — Деплой бота

1. Скопируйте `bot/bot.py`, `requirements.txt`, `Dockerfile`, `.env.example`
   на хостинг (Railway, Fly.io, VPS).
2. `cp .env.example .env` и заполните (новый токен + service role).
3. `docker build -t belfed-bot . && docker run --env-file .env belfed-bot`.
4. `@BotFather` → BelfedBot → `Edit commands`:

```
start - Главное меню
link - Привязать аккаунт сайта
status - Моя подписка
cancel - Отменить автопродление
```

---

## Шаг 9 — Сквозной тест (test mode)

1. В секретах `YOOKASSA_MODE=test`.
2. Создайте нового пользователя на belfed.ru.
3. Нажмите «Привязать Telegram» → deep-link → `/start` у бота →
   `profiles.telegram_id` заполнен.
4. Купите любой план тестовой картой `1111 1111 1111 1026`, любой срок,
   любой CVC, 3-DS код `12345678`.
5. После возврата на сайт:
   - `payments` → `status='succeeded'`
   - `subscriptions.payment_method_id` заполнен, `status='active'`
   - `profiles.subscription_expires_at` ≈ now + 1 месяц
   - Bot в DM прислал одноразовую invite-ссылку.
6. В Postgres вручную выставьте `subscriptions.next_billing_at = now()`
   и вызовите `yookassa-charge-recurring` — появится новый succeeded payment.
7. `/cancel` в боте → `cancel_at_period_end=true`.
8. `profiles.subscription_expires_at = now() - interval '2 days'`
   → вызвать `telegram-enforce-access` → вас кикает, приходит DM.

`YOOKASSA_MODE=live` переключать только после всех 7 пунктов.

---

## Шаг 10 — Юридическое

`oferta.html` (RU, уже есть) должна явно описывать:
- цена, период, автопродление, способ его отключения,
- политика возвратов,
- реквизиты (ИНН 781103296545, ОГРНИП 326784700016572, contact@belfed.com).

На `members.html` — короткий блок «Как отменить автопродление»
(кнопка + команда `/cancel` в боте). ЮKassa требует это при ревью автоплатежей.

---

## Чек-лист ввода в эксплуатацию

- [ ] Токен бота перевыпущен
- [ ] Миграция `20260424_002_access_and_rpcs.sql` применена
- [ ] 6 edge functions задеплоены (webhook с `--no-verify-jwt`)
- [ ] В кабинете ЮKassa прописан webhook
- [ ] 2 cron-задачи настроены
- [ ] Bot — админ платного канала с правами Invite + Ban
- [ ] Сквозной тест пройден
- [ ] `YOOKASSA_MODE=live`
- [ ] `oferta.html` обновлена, блок про отмену опубликован
