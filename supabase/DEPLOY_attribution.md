# Deployment manifest — Threads conversion attribution

Production-reconciliation deploy for PR #35. Every artifact below was diffed
against the **live** Supabase project (`obujqvqqmyfcfflhqvud`) before writing.
Nothing here replaces live business logic; all changes are additive.

## 1. Artifacts to deploy

### Migration (apply first)
- `supabase/migrations/20260713_026_attribution_conversion.sql`

Creates/【adds】:
- **NEW** table `public.conversion_funnel_events` (funnel events; separate from the
  pre-existing content-attribution table `public.conversion_attribution`, which is
  left untouched — see §4).
- Additive columns on existing `public.trial_intents`:
  `anonymous_id, attribution_key, first_touch jsonb, last_touch jsonb, landing_page`.
- RPCs: `record_conversion_event`, `record_signup_attribution`,
  `link_trial_intent_attribution`, `record_payment_attribution` (all SECURITY
  DEFINER, `service_role`-only).
- `CREATE OR REPLACE public.apply_successful_payment(...10 args...)` — **verbatim
  copy of the live body** + one guarded `record_payment_attribution` call before
  `RETURN v_new`.

### Edge functions
- `supabase/functions/_shared/attribution.ts`     (NEW shared sanitizer)
- `supabase/functions/trial-intent-create/index.ts` (live v5 + attribution)
- `supabase/functions/bot-claim-trial/index.ts`     (live v21 + attribution)

Deploy:
```
supabase functions deploy trial-intent-create
supabase functions deploy bot-claim-trial
```
(`_shared/attribution.ts` ships automatically as a relative import of both.)

**Do NOT redeploy** `yookassa-webhook`, `tribute-webhook`, or
`yookassa-create-payment` — they are unchanged. They gain payment attribution for
free because it now fires inside `apply_successful_payment`, which both webhooks
already call.

## 2. Expected live-version assumptions (verified at authoring time)

| Object | Live state assumed | Consequence if drifted |
|---|---|---|
| `apply_successful_payment` | 10-arg, `p_provider DEFAULT 'yookassa'`, RETURNS `timestamptz`; provider-scoped subscriptions upsert; admin no-downgrade guard; YooKassa saved-card capture | Re-diff Section E; port ONLY the `ATTRIBUTION` block into the current body |
| `claim_trial_by_telegram` | TWO overloads exist: **5-arg** `(id,username,days,source,lang)` and 11-arg (adds email/consent). `bot-claim-trial` calls the **5-arg** one | Keep the exact 5 named args; adding params risks PostgREST PGRST203 ambiguity |
| `trial_intents` | Exists; `privacy_consent_at`/`terms_consent_at` NOT NULL **with defaults**; lacks the 5 attribution columns | Migration's `ADD COLUMN IF NOT EXISTS` supplies them; no-op if already present |
| `conversion_attribution` | Exists as **content** attribution (queue_id/experiment_id/thread_id/published_url; `attribution_model`+`metadata`+`occurred_at` NOT NULL; no `event_key`) | We do NOT touch it; funnel uses `conversion_funnel_events` |
| `yookassa-webhook` | Calls `apply_successful_payment` with 9 args (default provider) | No change needed |
| `tribute-webhook` | Calls it with 10 args incl. `p_provider:"tribute"` | No change needed |

## 3. Post-deploy SQL smoke queries

Run against production **after** the migration + function deploys.

```sql
-- (a) Objects exist with expected shape
select to_regclass('public.conversion_funnel_events') as funnel_table;   -- not null
select proname, pronargs
from pg_proc where proname in
  ('record_conversion_event','record_signup_attribution',
   'link_trial_intent_attribution','record_payment_attribution');

-- (b) apply_successful_payment still has the 10-arg provider-aware signature
select pg_get_function_identity_arguments('public.apply_successful_payment'::regproc);
-- expect: ...p_is_test boolean, p_provider text

-- (c) claim_trial_by_telegram overloads still both present (5-arg + 11-arg)
select pg_get_function_identity_arguments(oid)
from pg_proc where proname='claim_trial_by_telegram';

-- (d) Idempotency: replay collapses to one row (safe; cleans up after itself)
select public.record_conversion_event('signup','trial-intent:__smoke__',
  null,'anon-smoke','akey-smoke',
  '{"utm_source":"threads","utm_medium":"social"}'::jsonb,'/ru/');
select public.record_conversion_event('signup','trial-intent:__smoke__',
  null,'anon-smoke','akey-smoke','{"utm_source":"MUTATED"}'::jsonb,'/ru/'); -- NULL
select count(*), max(utm_source) from public.conversion_funnel_events
  where event_key='trial-intent:__smoke__';           -- expect 1, 'threads'
delete from public.conversion_funnel_events where event_key='trial-intent:__smoke__';
```

Full transactional integration test (rolls itself back):
```
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/sql/attribution_idempotency.test.sql
```

Live end-to-end sanity (after a real test trial + test payment):
```sql
select event_type, utm_source, utm_campaign, value, currency, created_at
from public.conversion_funnel_events
order by created_at desc limit 10;
```

## 4. Why a new table instead of reusing `conversion_attribution`

The live `conversion_attribution` table is the **content** attribution store
(Threads posts: `queue_id`, `experiment_id`, `thread_id`, `published_url`), with
`attribution_model`, `metadata`, and `occurred_at` all `NOT NULL` and **no**
`event_key` column. Reusing it would (a) fail our inserts on those NOT NULL
columns, (b) require ALTERing a live analytics table, and (c) pollute existing
content dashboards with funnel rows. The funnel therefore lives in its own
`conversion_funnel_events` table. `conversion_attribution` is not read or written
by this change.

## 5. Rollback

Attribution is fully isolated and best-effort, so rollback is low-risk.

1. **Fastest / no-code** — stop attribution writes without reverting anything:
   the edge-function attribution calls are wrapped in try/catch and the SQL
   `record_payment_attribution` call is in a `BEGIN…EXCEPTION WHEN OTHERS` block,
   so failures are already swallowed. Dropping the RPCs makes them no-ops:
   ```sql
   DROP FUNCTION IF EXISTS public.record_payment_attribution(text,text,uuid,numeric,text);
   -- apply_successful_payment's guarded PERFORM then logs a warning and continues.
   ```

2. **Revert `apply_successful_payment`** to the pre-deploy body (re-run the
   captured live definition, i.e. the Section E body minus the ATTRIBUTION block).
   Signature is unchanged, so callers are unaffected.

3. **Redeploy the previous function versions** if needed:
   `trial-intent-create` → v5, `bot-claim-trial` → v21 (both are the bodies these
   files were reconciled from; the attribution additions are the only delta).

4. **Data**: `conversion_funnel_events` can be dropped with no impact on billing,
   trials, or content attribution:
   ```sql
   DROP TABLE IF EXISTS public.conversion_funnel_events;
   ```
   The `trial_intents` attribution columns are nullable and inert; leave or drop.

No rollback step touches `payments`, `subscriptions`, `profiles`, or
`conversion_attribution`.
