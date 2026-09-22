# ADR 0001 — Versioned consent ledger

- Status: Proposed
- Date: 2026-07-23
- Scope: Data model + edge-function contract for provable consent. **No migration is created or run in this PR** — this document specifies the target design so a future, separately reviewed PR can implement it.

## Context

The 2026-07-23 legal/compliance audit (152-ФЗ, 38-ФЗ) found that consent is
collected but not stored in a way that proves *what* the subject agreed to and
*when*. Today:

- `public.profiles` carries `privacy_consent_at`, `terms_consent_at`,
  `consent_ip`, `consent_user_agent`, `consent_locale`, `trial_source`
  (added out-of-band, guarded idempotently in migration
  `20260701_023_web_signup_consent_persistence.sql`).
- The trigger `profiles_autostart_trial()` stamps those columns from
  `auth.users.raw_user_meta_data` at profile creation.
- The landing lead/asset-request form (`index.html`) posts to the
  `landing-lead-create` edge function (source not in this repo).

Gaps versus the audit:

1. Only a *timestamp* is stored — not the exact wording, document version, or a
   hash of the text the subject saw. Burden of proof (ч. 3 ст. 9 152-ФЗ) is on
   the operator.
2. Consent is overwrite-in-place on the profile row; there is no immutable
   history of grants and withdrawals.
3. Marketing consent (38-ФЗ ст. 18) is not tracked as a separate, provable,
   optional flag distinct from service/data-processing consent.

## Decision

Introduce an append-only `public.consent_events` ledger. Each row is one
immutable consent action (grant or withdrawal) for one purpose.

### Proposed schema (target — not applied here)

```sql
-- FUTURE migration, do NOT apply in this PR.
create table public.consent_events (
  id             bigint generated always as identity primary key,
  subject_id     uuid,                 -- profiles.id / auth.users.id when known
  subject_email  text,                 -- for pre-auth leads with no user row yet
  purpose        text not null,        -- 'privacy' | 'terms' | 'marketing' | 'distribution'
  action         text not null,        -- 'grant' | 'withdraw'
  doc_version    text not null,        -- e.g. 'privacy@2.0', 'oferta@3'
  doc_hash       text not null,        -- sha-256 of the exact rendered consent text
  consent_text   text not null,        -- exact wording shown to the subject
  locale         text not null,        -- 'ru' | 'en'
  source         text not null,        -- 'landing' | 'trial_web_ru' | 'telegram' | ...
  ip             text,                 -- only when lawfully and minimally collected
  user_agent     text,
  created_at     timestamptz not null default now()
);
create index on public.consent_events (subject_id, purpose, created_at desc);
create index on public.consent_events (subject_email, purpose, created_at desc);
```

Effective consent for a `(subject, purpose)` is the latest row by `created_at`.
`profiles.*_consent_at` columns remain as a denormalised cache for fast reads.

### Field mapping to what the audit requires

| Audit requirement            | Column(s)                          |
|------------------------------|------------------------------------|
| Document version             | `doc_version`                      |
| Hash of exact text           | `doc_hash`                         |
| Exact text + purpose         | `consent_text`, `purpose`          |
| Locale / source of form      | `locale`, `source`                 |
| Timestamp                    | `created_at`                       |
| Withdrawal                   | `action = 'withdraw'` (new row)    |
| Separate marketing flag      | `purpose = 'marketing'`            |

## Client contract (already shipped in this PR, forward-compatible)

The web forms now send explicit, separated purposes so the future edge
function can write ledger rows without another front-end change:

- **Signup** (`ru/trial.html` → `trial-intent-create`): `accept_privacy`,
  `accept_terms` (both required, unchecked by default), plus `source`, `lang`.
- **Landing lead/asset request** (`index.html` → `landing-lead-create`):
  - `data_consent` (bool, **required** to submit) — processing of email + request;
  - `marketing_consent` (bool, **optional**) — 38-ФЗ advertising opt-in;
  - `consent` (bool) — retained as a backward-compatible alias of
    `marketing_consent` so the currently-deployed function keeps working;
  - `consent_locale` (`'ru'`).

`doc_version` / `doc_hash` are **not** sent by the client yet; the edge function
should derive them server-side from a versioned catalogue of consent strings so
the hash cannot be spoofed by the client. Until then, the ledger can be
populated with `doc_version`/`doc_hash` computed server-side and
`consent_text` looked up by `(purpose, locale, version)`.

## Backward-compatible rollout

1. **This PR (front-end only):** forms emit separated, unchecked-by-default
   consent fields; `consent` alias preserved. No schema change. If the deployed
   `landing-lead-create` ignores unknown fields, behaviour is unchanged except
   that `consent` now reflects the *optional* marketing box (default `false`)
   instead of a pre-checked `true`.
2. **Backend PR (separate):** add `consent_events` (additive, no destructive
   change); server derives `doc_version`/`doc_hash`; dual-write to the ledger
   and to the existing `profiles.*_consent_at` cache.
3. **Cutover:** reads that need proof move to `consent_events`; `profiles`
   columns kept as cache.

## Rollback

- Front-end: revert this PR — forms return to prior markup. No data migration
  involved.
- Backend (when built): `consent_events` is additive; dropping the table (or
  ceasing dual-write) restores prior behaviour because `profiles.*_consent_at`
  remains the source the app already reads. No backfill is destroyed.

## Explicit non-goals / dependencies

- No migration is added or executed in this PR (per task constraints).
- `landing-lead-create` source is not in this repo; the new `data_consent` /
  `marketing_consent` handling and any ledger writes require a change in that
  (separately deployed) function. Tracked as an open dependency in the PR body.
- No legal-consent backfill for historical rows (consistent with migration 023).
