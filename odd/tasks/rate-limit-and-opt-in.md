# Rate limit and opt-in consent for unknown senders

## Objective

Make the bot safe to expose to any WhatsApp sender by bounding cost per sender and
recording explicit consent before any non-deterministic (Claude) processing or
history persistence happens for a party that has not opted in.

## Problem

Today every sender that reaches the business number is served the full pipeline:
`getBoundedHistory` reads stored history, `processIncomingMessage` may call Claude,
and both sides of the exchange are appended to `conversaciones`. There is no sender
allow-list, no rate limit, and no consent record.

Consequences, in order of severity:

1. **Unbounded cost.** Every unknown sender triggers a Claude call on the hot path.
2. **No consent record.** `docs/02-usuarios.md:29` already states there is no digital
   consent mechanism and no way to access, export, or delete history. That is
   defensible for an existing patient and not defensible for an arbitrary stranger.
3. **Transcript retention without consent.** Non-consented exchanges are written into
   `conversaciones.historial` today.
4. **No abuse brake.** Any number can drive unbounded volume through the pipeline.

## Why this shape

The user chose to gate **only the free-form Claude chat**. The psychologist's own
listing data in `psicologos` (`precio`, `horarios`, `direccion`, `link_calcom`) is
public by nature: publishing it costs nothing, exposes nothing, and is exactly what a
prospective patient needs. What is expensive and sensitive is the open-ended
conversation.

So a non-consented sender gets the deterministic local answers plus an explicit
consent request, and nothing else.

### Crisis is never gated

`isCrisisSignal` lives in `_shared/router.ts` behind the rest of the pipeline, and the
crisis branch returns before any Claude call. Crisis handling therefore costs
essentially nothing, so gating it would buy no protection while creating a real harm:
a person in crisis writing for the first time would receive an opt-in prompt instead
of the suicide-prevention line. Crisis detection is checked **before** the rate limit
and before consent, and takes the existing full path unchanged.

## Scope

In scope:

- `supabase/migrations/006_*.sql` — `sender_consents` and `sender_rate_buckets`.
- `supabase/functions/_shared/gate.ts` — new gate module.
- `supabase/functions/_shared/router.ts` — export the deterministic branch so the
  gate reuses it instead of duplicating it.
- `supabase/functions/_shared/supabase.ts` — consent and rate-limit data access.
- `supabase/functions/webhook/index.ts` — wire the gate into `processMessage`.
- `supabase/functions/_shared/phase1.test.ts` — regression coverage.

Out of scope:

- Anything in `src/**` (non-deployed Node compatibility tree).
- `.env` / `.env.example` (permission-denied to this agent).
- Sender allow-lists (pending decision P1), per-tenant Meta credentials (P3),
  tenant-scoping `mensajes_procesados` (P4).
- Any UI.

## Constraints

- **Do not change existing behavior for a consented sender.** A consented sender must
  traverse exactly today's pipeline: same routing order, same persistence, same
  crisis handling, same idempotency.
- **Do not weaken crisis handling.** The refactor of `router.ts` must preserve the
  current precedence exactly: empty message, then crisis, then scheduling, then
  clinical, then quick admin, then Claude. Crisis must keep priority over scheduling
  and clinical detection.
- **No persistence for non-consented senders.** Their exchanges are not appended to
  `conversaciones`. Deterministic answers are self-contained, so no continuity is
  lost.
- Rate limiting must be race-free under concurrent webhooks.
- Additive migration only. No destructive schema change, no RLS policy added; all
  access stays `service_role`.
- Technical artifacts in English.

## Gate decision order

Evaluated in exactly this order:

1. **Crisis** — `isCrisisSignal`. Full existing path, persisted with the existing
   crisis redaction. Bypasses the rate limit, because this path costs no LLM call.
2. **Rate limit** — fixed one-hour window, per `(psicologo_id, numero_remitente)`.
   Distinct ceilings for consented and non-consented senders.
3. **Consented** — full existing path.
4. **Opt-in token** — record consent, confirm, reply with the greeting. No Claude.
5. **Otherwise** — deterministic local answer plus a consent request. No Claude, no
   persistence, no conversation row.

## Tunable defaults

Chosen defaults, each a named constant with a comment explaining the tradeoff:

- Non-consented ceiling: 10 messages per hour.
- Consented ceiling: 60 messages per hour. A real therapy conversation is long, and
  this path does call Claude, so the ceiling must not truncate a live session.
- Opt-in tokens, matched case-insensitively after accent stripping and whitespace
  collapsing: `QUIERO`, `SI`, `ACCEPTO`, `OK`, `DE ACUERDO`.
- Revoking consent is a `DELETE` of the consent row; no separate state is needed.

These are product defaults, not verified requirements. They must be isolated as
constants so they can be retuned without touching logic.

## Tasks

- [ ] T1 — Migration 006: `sender_consents` with a unique
      `(psicologo_id, numero_remitente)` index, and `sender_rate_buckets` keyed by
      `(psicologo_id, numero_remitente, window_started_at)` so the counter increment
      is a single atomic upsert.
- [ ] T2 — `supabase.ts`: `hasSenderConsent`, `recordSenderConsent`, and
      `consumeRateLimitSlot` returning the resulting count for the current window.
- [ ] T3 — `router.ts`: export `greetingResponse` and `routeDeterministicMessage`
      without changing `routeMessage` precedence.
- [ ] T4 — `gate.ts`: the ordered decision, the opt-in token matcher, and the
      consent prompt text.
- [ ] T5 — Wire the gate into `processMessage`, after `getPsicologo` resolves and
      before `getOrCreateConversacion`.
- [ ] T6 — Regression tests for every branch and for the precedence guarantee.
- [ ] T7 — Run `npm run test:edge` and `npm test`; record actual output.

## Authorized scope of writes

`supabase/migrations/006_*.sql`, `supabase/functions/_shared/gate.ts`,
`supabase/functions/_shared/router.ts`, `supabase/functions/_shared/supabase.ts`,
`supabase/functions/webhook/index.ts`,
`supabase/functions/_shared/phase1.test.ts`, and this document.

## Acceptance criteria

- A non-consented sender reaches no Claude call and writes no history.
- A non-consented sender still receives price, schedule, address, and the Cal.com
  link, plus an explicit consent request.
- A crisis signal from a non-consented, rate-limited sender still receives the crisis
  response.
- A consented sender's behavior is byte-for-byte today's pipeline.
- Consent is recorded per `(psicologo_id, numero_remitente)` and is revocable by
  deleting the row.
- The rate-limit counter is a single atomic statement; concurrent webhooks cannot
  both consume the same slot.
- `routeMessage` precedence is unchanged.
- Both test commands run and their real output is recorded below.

## Pending decisions (not authorized)

- [ ] P1 — Dead `PSICOLOGO_NUMERO_WATCHLIST` in `.env.example`.
- [ ] P3 — Per-tenant Meta credentials.
- [ ] P4 — Tenant-scope `mensajes_procesados`.
- [ ] P5 — Rotate and de-track exposed credentials.
- [ ] P6 — Non-array `historial` coerced to `'[]'` by migration 005.
- [ ] P8 — Consent proof and data-subject deletion. A `DELETE` revokes consent but
      does not erase history already stored for a previously consented sender. That
      is a GDPR question, not an engineering one, and needs a product decision.

## Progress

Feature document created before the first source write. No source changes yet.

## Verification evidence

_(to be filled with real command output)_

## Next step

Execute T1.