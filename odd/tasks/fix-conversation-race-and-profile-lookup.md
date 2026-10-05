# Fix conversation write race and profile full-scan lookup

## Objective

Eliminate two verified correctness/efficiency defects in the production WhatsApp
pipeline (`supabase/functions/**`, Deno runtime) that become materially worse once
any unknown sender can reach the business number.

## Problem

1. **Non-atomic conversation creation.** `getOrCreateConversacion`
   (`supabase/functions/_shared/supabase.ts:297-331`) resolves a conversation with a
   `maybeSingle()` read and then issues a separate `insert()`. `conversaciones` has
   no unique constraint on its logical key, so two concurrent deliveries of the same
   message create duplicate conversation rows and permanently split the patient
   history.
2. **Full-table profile scan per inbound message.** `getPsicologo`
   (`supabase/functions/_shared/supabase.ts:66-81`) calls
   `.from('psicologos').select('*')` with no filter and resolves the profile in
   client-side JS. Every inbound message reads the whole table, and the partial
   unique index on `meta_phone_number_id`
   (`supabase/migrations/004_phase1_p0_security_context.sql:8-10`) can never be used.

## Why

The bot currently accepts every sender with no allow-list and no consent gate. Both
defects scale with the number of distinct senders, so they must be closed before
onboarding non-patient traffic.

## Scope

In scope:

- `supabase/migrations/` — new additive migration for the unique constraint.
- `supabase/functions/_shared/supabase.ts` — atomic conversation upsert, indexed
  profile lookup.
- `supabase/functions/_shared/phase1.test.ts` — regression coverage.

Out of scope (requires a separate product decision, tracked below):

- Sender policy, rate limiting, opt-in consent, per-tenant Meta credentials.
- Removal of the sole-row profile fallback (pinned by an existing test).
- Anything in `src/**` (non-deployed Node compatibility tree, already divergent).
- Any change to `.env` or `.env.example` (out of permission scope for this agent).

## Constraints

- Behavior-preserving. `selectPsicologoFromRows` keeps its exact current semantics
  so `phase1.test.ts:180` (sole-row fallback) stays green.
- No RLS grants added. All access stays `service_role`.
- Additive migration only; no destructive schema change.
- Technical artifacts in English.

## Tasks

- [x] T1 — Add `unique (psicologo_id, numero_paciente)` on `conversaciones` as an
      additive migration, with de-duplication of any pre-existing rows.
- [x] T2 — Rewrite `getOrCreateConversacion` to a single atomic upsert that cannot
      create duplicate conversation rows under concurrency.
- [x] T3 — Replace the unfiltered `select('*')` in `getPsicologo` with a targeted
      query on `meta_phone_number_id`, preserving the documented sole-row fallback
      semantics via a bounded fallback query.
- [x] T4 — Add regression tests covering concurrent/repeated conversation
      resolution and indexed profile resolution.
- [x] T5 — Run `npm run test:edge` and `npm test`; record actual output.
- [x] T6 — Make the historial timestamp parse exception-safe so no `historial` value
      can abort the migration before the `UNIQUE` constraint is created
      (native finding `R3-MALFORMED-HISTORY`).
- [x] T7 — Pin `datestyle` and `timezone` for the transaction so the documented
      merge-order guarantee does not depend on the runner's session GUCs.

## Authorized scope of writes

`supabase/migrations/*`, `supabase/functions/_shared/supabase.ts`,
`supabase/functions/_shared/phase1.test.ts`, and this document.

## Acceptance criteria

- A migration exists that guarantees one conversation row per
  `(psicologo_id, numero_paciente)`.
- `getOrCreateConversacion` issues a single upsert and is safe to call twice with
  the same arguments.
- `getPsicologo` no longer performs an unfiltered table scan on the hot path.
- `selectPsicologoFromRows` semantics are unchanged and its existing tests pass.
- Both test commands run and their real output is recorded below.

## Pending decisions (not authorized)

- [ ] P1 — Sender authorization policy. `PSICOLOGO_NUMERO_WATCHLIST`
      (`.env.example:25`) is dead config with zero source references. Either
      implement it or delete it so it stops implying a control that does not exist.
      Requires a product decision.
- [ ] P2 — Rate limiting and explicit opt-in consent before public exposure.
- [ ] P3 — Per-tenant Meta credentials. `sendMessage`
      (`supabase/functions/_shared/whatsapp.ts:70`) has no tenant parameter and
      always reads global `META_PHONE_NUMBER_ID` / `META_ACCESS_TOKEN`, so
      per-number delivery is impossible by construction.
- [ ] P4 — Tenant-scope `mensajes_procesados` (add `psicologo_id`, `from`). The
      idempotency ledger is tenant-blind, which blocks audit and per-tenant
      idempotency. Deferred because it requires reordering claim vs. profile
      resolution in `webhook/index.ts`.
- [ ] P5 — Rotate and de-track exposed credentials. `.env.example` is tracked in
      git and reportedly contains a live service-role key (bypasses RLS) and Meta
      token. Rotation is a console action and can only be performed by the
      maintainer.
- [ ] P6 — A non-array `historial` is coerced to `'[]'` by the merge, silently
      discarding content and contradicting this file's "never discarded" claim. The
      column carries no `CHECK (jsonb_typeof(historial) = 'array')`. Not authorized
      in this change; needs its own work unit.
- [ ] P7 — The migration is all-or-nothing, so a `statement_timeout` or
      `pg_cancel_backend` during the merge still leaves `conversaciones` without its
      constraint. PL/pgSQL `when others` excludes `QUERY_CANCELED`, so the exception
      handler cannot absorb it. Not a regression and not data-dependent; consider
      splitting the merge from the constraint if the table ever grows large.

## Progress

All five tasks are implemented and verified. No commit was created: the parent
orchestrator owns the work-unit commit.

- `supabase/migrations/005_conversaciones_unique_psicologo_patient.sql` — new.
  De-duplicates pre-existing duplicate groups (merging `historial`, never
  discarding it), then adds the real `UNIQUE` constraint. Idempotent.
- `supabase/functions/_shared/supabase.ts` — `getOrCreateConversacion` is now one
  atomic `upsert` on `psicologo_id,numero_paciente`; `getPsicologo` now runs a
  filtered indexed lookup and only then a bounded `.limit(2)` fallback.
  `selectPsicologoFromRows` is untouched.
- `supabase/functions/_shared/phase1.test.ts` — three regression tests added.

### Deployment ordering constraint

Migration 005 **must be applied before** the updated Edge Function is deployed.
The new upsert depends on the unique constraint; without it PostgREST fails with
"no unique or exclusion constraint matching the ON CONFLICT specification", which
surfaces as `getOrCreateConversacion` returning `null` and the webhook retrying
the message.

## Verification evidence

- `npm run test:edge`: `ok | 22 passed | 0 failed (52ms)`. Baseline before this
  change was `19 passed | 0 failed`; the three new tests are the difference.
  Deno's type-check of `supabase/functions/_shared/phase1.test.ts` also passes.
- `npm test`: `# tests 13 / # pass 13 / # fail 0`. Unchanged from baseline; that
  suite covers the non-deployed `src/**` tree, which was not modified.
- Regression tests confirmed to actually catch the defects: with the original
  `supabase.ts` restored, all three new tests FAIL
  (`phase1.test.ts:313`, `:335`, `:383`) while
  `does not select a first profile when multiple rows have no matching ID`
  (the pinned sole-row assertion) still passes.
- Migration 005 executed against a real PostgreSQL 17 instance with seeded
  duplicate groups. Verified: 3-row group collapsed to 1; survivor chosen by
  greatest `updated_at`; tie on `updated_at` broken by greatest `created_at`;
  all-`NULL` timestamps broken by lowest `id`; same `numero_paciente` under a
  different `psicologo_id` correctly left as two rows; `historial` merged in
  chronological order with malformed/missing timestamps preserved and ordered
  last; `created_at` = `min`, `updated_at` = `max`; `ultima_actividad` untouched;
  a real `UNIQUE` constraint present; the `set_updated_at` trigger re-enabled;
  re-running the migration deleted 0 rows and skipped the constraint; and the
  exact upsert shape used by `getOrCreateConversacion` returned the pre-existing
  row with its `historial` and `created_at` intact.

### Environment note

`deno` is not installed on this machine, so `npm run test:edge` fails with
`sh: deno: command not found` until Deno is installed. The results above were
produced with Deno 2.9.7.

## Next step

Parent orchestrator: create the work-unit commit and apply migration 005 to the
database before deploying the Edge Function.
