# BelFed — интеграция платежей ЮKassa (RU only)

Полная настройка платной подписки в Telegram c **14-дневным бесплатным
триалом без привязки карты**, единым тарифом 1 500 ₽/мес, автопродлением,
чеками 54-ФЗ, выдачей доступа и отменой. EN-версия будет добавлена
отдельным PR, когда определитесь с международным провайдером.

> Все платежи принимаются только в рублях и только российскими картами
> (Мир, Visa/MC РФ-эмиссии), СБП, YooMoney, SberPay, Tinkoff Pay.
> Поэтому весь платный UI живёт только на **belfed.ru**. Сайт belfed.com
> в этом PR не меняется.

---

## Архитектура

```
 Регистрация на belfed.ru/members.html (signUp)
   │
   ▼
 Supabase: insert profiles
   │ → trigger profiles_autostart_trial:
   │     subscription_plan = 'trial'
   │     subscription_expires_at = now() + 14 days
   │     trial_started_at = now()
   ▼
 Пользователь видит «🎁 Пробный доступ — 14 дней»
 Нажимает «Привязать Telegram» → deep-link → /start у бота
   │
   ▼
 Bot: claim_telegram_link → grant_paid_invite (1 час, single-use)
   │ Пользователь заходит в платный Telegram-канал.
   │
   ▼
 За 6–36 ч до окончания триала
   cron telegram-trial-reminder → DM с кнопкой «Оформить за 1 500 ₽».
   │
   ▼ (если оплатил — переход в paid-флоу)
 belfed.ru/members.html → кнопка «Оформить — 1 500 ₽ / мес»
   │
   ▼
 Edge: yookassa-create-payment
   │ api.yookassa.ru (save_payment_method=true, receipt, способ карта/СБП)
   ▼
 Платёжная форма ЮKassa
   │
   ▼
 ЮKassa → HTTP-уведомление → Edge: yookassa-webhook
   │  - проверка IP ЮKassa (CIDR allowlist v4 + v6)
   │  - дедуп по payment_events
   │  - RPC apply_successful_payment → subscription_plan='monthly',
   │    subscription_expires_at = max(текущее, now()) + 1 мес
   │  - upsert subscriptions с payment_method_id
   │  - DM с invite-ссылкой (если ещё не было)
   ▼
 Cron 0 */6  * * *  yookassa-charge-recurring     — авто-списание
 Cron 15 */6 * * *  telegram-trial-reminder       — напоминание в день 13
 Cron 30 */6 * * *  telegram-enforce-access       — кик через 24 ч grace

 /cancel (бот) или кнопка на сайте
   → subscriptions.cancel_at_period_end = true
```

Пользователь остаётся в канале до конца оплаченного периода.
После истечения + 24 ч grace `telegram-enforce-access` кикает его
с DM «Доступ закончился. Продлить за 1 500 ₽?».

Если по итогу 14 дней триала оплаты не было — `telegram-enforce-access`
тоже кикает (24 ч grace).

---

## Шаг 0 — Предусловия

- Магазин ЮKassa полностью верифицирован, работает **по API-протоколу**
  (в кабинете → Магазин; если поля «протокол» нет — напишите в поддержку
  с указанием ShopID).
- Подключена касса (ФН) / чеки ЮKassa / ОФД — чеки 54-ФЗ обязательны.
- Менеджер ЮKassa **включил автоплатежи** (recurring) на боевом магазине.
  На тестовом магазине они работают по умолчанию.
- Бот (`@BelfedBot`) — **администратор** платного канала с правами
  *Приглашать пользователей* и *Банить участников*.

---

## Шаг 1 — Перевыпуск токена бота

Текущий `bot.py` содержал токен в открытом виде. Его надо перевыпустить:

1. `@BotFather` → `/mybots` → BelfedBot → `API Token` → **Revoke current token**.
2. Новый токен положите в Supabase Edge Secrets и в env хостинга бота.

---

## Шаг 2 — Миграции БД

Применить **по порядку**, обе идемпотентны.

Supabase Dashboard → **SQL Editor → New query** → вставить файл → Run.

| # | Файл | Что делает |
|---|---|---|
| 1 | `supabase/migrations/20260424_002_access_and_rpcs.sql` | таблицы `payment_events`, `telegram_access_log`, RPC `apply_successful_payment`, `claim_telegram_link`, view `subscriptions_for_charge`, view `users_for_enforce_access` |
| 2 | `supabase/migrations/20260426_003_single_plan_and_trial.sql` | `app_config.price_month_rub=1500`, `default_plan=monthly`, `trial_days=14`; добавляет `profiles.trial_started_at`, `profiles.trial_reminder_sent_at`; RPC `start_trial(uuid)`; **trigger `profiles_autostart_trial` BEFORE INSERT** — авто-триал; view `users_for_trial_reminder` |

---

## Шаг 3 — Секреты Edge Functions

Supabase Dashboard → **Project Settings → Edge Functions → Secrets**:

| Ключ | Значение |
|---|---|
| `YOOKASSA_MODE` | `test` (переключить на `live` после теста) |
| `YOOKASSA_TEST_SHOP_ID` / `YOOKASSA_TEST_SECRET_KEY` | из тестового магазина |
| `YOOKASSA_LIVE_SHOP_ID` / `YOOKASSA_LIVE_SECRET_KEY` | из боевого магазина |
| `YOOKASSA_RETURN_URL` | `https://belfed.ru/members.html?payment=return` |
| `YOOKASSA_VAT_CODE` | `1` (без НДС — УСН) |
| `YOOKASSA_TAX_SYSTEM` | `2` (УСН доходы) — опционально |
| `PRICE_MONTHLY_RUB` | `1500` |
| `TELEGRAM_BOT_TOKEN` | новый токен из шага 1 |
| `TELEGRAM_BOT_USERNAME` | `BelfedBot` (без @) |
| `TELEGRAM_PAID_CHAT_ID` | `-1003660492325` |
| `TELEGRAM_COMMUNITY_RU_ID` | `-1003773738299` (опц.) |
| `BELFED_WEB_URL` | `https://belfed.ru` |

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
supabase functions deploy telegram-trial-reminder
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

Supabase → **Edge Functions → Cron**. Везде Method `POST`,
заголовок `Authorization: Bearer <SERVICE_ROLE_KEY>`:

| Имя | Расписание (UTC) | Функция | Назначение |
|---|---|---|---|
| `charge-recurring` | `0 */6 * * *` | `yookassa-charge-recurring` | Списания по сохранённым картам. |
| `trial-reminder` | `15 */6 * * *` | `telegram-trial-reminder` | DM пользователю за 6–36 ч до конца триала. |
| `enforce-access` | `30 */6 * * *` | `telegram-enforce-access` | Кикает после grace 24 ч. |

---

## Шаг 7 — Подключение на сайте belfed.ru

В этом PR уже включены готовые правки, ничего вручную делать не нужно
кроме мерджа:

- **`/ru/index.html`** — добавлена секция «// Подписка и доступ»
  с карточкой 1 500 ₽ / мес и CTA «Начать 14 дней бесплатно» → `/members.html`.
- **`/members.html`**:
  - кнопка регистрации переименована в «Начать 14 дней бесплатно»;
  - добавлен баннер «🎁 Пробный доступ — 14 дней» (показывается только
    в режиме триала, скрыт после оплаты);
  - блок «// Моя подписка» использует виджет `belfed-subscription.js`
    (статус ACTIVE / TRIAL / NONE, кнопки «Привязать Telegram»,
    «Оформить — 1 500 ₽ / мес», «Отменить автопродление»);
  - подключён `belfed-subscription.js`.
- **`/belfed-subscription.js`** — единый план, триал-aware рендер,
  CSS-классы `bf-card`, `bf-status`, `bf-cta`, `bf-danger`, `bf-on`, `bf-off`
  стилизуются прямо в `members.html`.

CSP `members.html` уже разрешает `connect-src https://*.supabase.co`.

> `belfed.com` в этом PR не изменяется.

---

## Шаг 8 — Деплой бота

1. Скопируйте `bot/bot.py`, `requirements.txt`, `Dockerfile`, `.env.example`
   на хостинг (Railway, Fly.io, VPS).
2. `cp .env.example .env` и заполните (новый токен из Шага 1 + service role + `PRICE_MONTHLY_RUB=1500`).
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
2. Зарегистрируйтесь как новый пользователь на belfed.ru.
   - В `profiles` должен появиться `subscription_plan='trial'`,
     `subscription_expires_at ≈ now()+14 days`, `trial_started_at = now()`.
3. Нажмите «Привязать Telegram» → deep-link → `/start` у бота →
   `profiles.telegram_id` заполнен, бот прислал invite-ссылку
   в платный канал. Войдите.
4. Вручную выставьте `profiles.subscription_expires_at = now() + 12 hours`
   и вызовите `telegram-trial-reminder` — должно прийти DM.
5. На сайте нажмите «Оформить — 1 500 ₽ / мес». Тестовая карта
   `1111 1111 1111 1026`, любой срок, любой CVC, 3-DS код `12345678`.
6. После возврата:
   - `payments` → `status='succeeded'`,
   - `subscriptions.payment_method_id` заполнен, `status='active'`,
   - `profiles.subscription_plan='monthly'`,
   - `profiles.subscription_expires_at ≈ now() + 1 месяц`,
   - DM не дублируется.
7. В Postgres вручную выставьте `subscriptions.next_billing_at = now()`
   и вызовите `yookassa-charge-recurring` — появится новый succeeded payment.
8. `/cancel` в боте → `cancel_at_period_end=true`.
9. `profiles.subscription_expires_at = now() - interval '2 days'`
   → вызвать `telegram-enforce-access` → вас кикает, приходит DM.

`YOOKASSA_MODE=live` переключать только после всех 9 пунктов.

---

## Шаг 10 — Юридическое

`oferta.html` (RU) описывает:
- цена 1 500 ₽ / мес, период 30 дней,
- 14-дневный пробный доступ без привязки карты,
- автопродление включается **только** после первой оплаты,
- отмена автопродления — кнопка «Отменить автопродление» на /members.html
  или команда `/cancel` в боте,
- политика возвратов,
- реквизиты ИП Фёдоров А.И. (ИНН 781103296545, ОГРНИП 326784700016572,
  contact@belfed.com).

ЮKassa проверяет наличие явной отмены автоплатежа при ревью recurring.

---

## Чек-лист ввода в эксплуатацию

- [ ] Токен бота перевыпущен (Шаг 1)
- [ ] Миграция `20260424_002_access_and_rpcs.sql` применена
- [ ] Миграция `20260426_003_single_plan_and_trial.sql` применена
- [ ] 7 edge functions задеплоены (webhook с `--no-verify-jwt`)
- [ ] В кабинете ЮKassa прописан webhook
- [ ] 3 cron-задачи настроены (charge / trial-reminder / enforce)
- [ ] Bot — админ платного канала с правами Invite + Ban
- [ ] Сквозной тест пройден (9 пунктов)
- [ ] `YOOKASSA_MODE=live`, recurring включён менеджером ЮKassa
- [ ] `oferta.html` обновлена, блок «Отменить автопродление» виден
