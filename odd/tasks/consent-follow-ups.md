# Consent and data rights: follow-ups from the #6 reviews (issue #7)

Objective: close the non-blocking advisories of issue #7, plus the sequence grant found while verifying production.
Branch: `feat/consent-follow-ups`. Delivery: `single-pr`. Test runner: `deno test` over `supabase/functions/_shared/phase1.test.ts`; SQL against a disposable Postgres container (`docs/09`).

## Specs

Quoted from issue #7 unless noted.

- S1 "**ACEPTO takes no per-sender lock.** [...] If ELIMINAR and ACEPTO from the same sender interleave, a `granted` event can land after the erasure. Fix: move the grant into a SQL function that takes the same lock and checks the prompt was shown."
- S2 "**Crisis exchange on a failed consent read.** `persistCrisisExchange` skips storing the redacted crisis marker when the consent read fails (`lookupFailed`) [...] Decide whether this fail-closed behavior is intended, and pin it with a test." Assumption (not confirmed by the user): fail-closed is intended, because storage requires proven consent, as in the gate.
- S3 "**Bare \"pánico\" overmatches.** [...] administrative questions that mention it get the clinical referral and are stored as a marker."
- S4 "**Clinical keyword coverage.** \"estoy deprimida\", \"tomo sertralina\", \"no puedo dormir\" are not detected as clinical".
- S5 "**Command words are duplicated.** Reply texts (`OPT_IN_CONFIRMED_NOTICE`, `REVOKED_NOTICE`, `NOTHING_TO_REVOKE_NOTICE`, `consentReminder`) and the seeded policy text spell out ACEPTO, BAJA and ELIMINAR instead of using `OPT_IN_TOKENS`, `REVOKE_TOKEN` and `ERASE_TOKEN`."
- S6 "**`isClinicalRefusal` is coupled to a substring.** It checks for \"atención directa\", an unstated fragment of `CLINICAL_REFERRAL_RESPONSE`. Derive the check from the constant."
- S7 "**Retention and window literals.** The 90 days appear in the purge default, the cron script, the preview query, the consent text and the docs. The 2-hour counter retention in `erase_sender_data` silently depends on `RATE_LIMIT_WINDOW_MS` being one hour."
- S8 "**Naming.** The gate's `erased` variable holds \"a consent was also withdrawn\", not \"data was erased\"."
- S9 "**Purge SQL test** asserts exact counts, so it only passes on a fresh database."
- S10 (found in production, 2026-11-10) `anon` and `authenticated` hold ALL on `consent_events_id_seq` through Supabase default privileges; revoke it.

## Tasks

| ID | Specs | Route | Status | Evidence |
|---|---|---|---|---|
| T1 | S1, S7 (2-hour window), S8, S9, S10 | inline | done | RED: SQL `record_sender_consent` missing, 4 Deno failures; GREEN: SQL exit 0, Deno 58/58 |
| T2 | S2, S3, S4, S6 | inline | done | RED: "estoy deprimida" not clinical; GREEN: Deno 61/61; differential vs base: only the requested phrases change |
| T3 | S5, S7 (cron/docs) | inline | pending | |

## Log

- L1 (2026-11-10) User: "vamos con el punto 2, el issue 7".
- L2 Design: migration 009 adds `record_sender_consent` (same advisory lock as 008, requires the prompt row of the active policy), drops the direct `INSERT` of `service_role` on `consent_events` so the lock cannot be bypassed, replaces the 2-hour literal in `erase_sender_data` with the current rate window passed by the Edge Function, and revokes the sequence grant. Clinical matching becomes accent-insensitive. The publish step gains a check that a published policy names ACEPTO, BAJA and ELIMINAR.
- L3 T1 done. S8 folded into T1 because the renamed line is the one that now passes the window. S9 also done in T1: the purge test asserts lower bounds plus the rows themselves. A refused ACEPTO (prompt erased) shows the full consent text again and records the prompt. Risk: item 2 (consent_events and sequence grants) and item 3 (erase_sender_data signature, consumed only by the webhook).
- L4 T1 review (lineage review-cfaaaf5ce650e739): approved with informational warnings and acknowledged. Follow-up: erase_sender_data now takes the per-sender lock itself (R3-003); the documented UPDATE publish flow is tested against the new constraint (R3-002); production holds only the unpublished draft, which names the three words, so the constraint cannot abort 009 there (R4). Accepted: ACEPTO and ELIMINAR fail honestly between applying 009 and deploying the webhook; the policy is unpublished, so only ELIMINAR is exposed, for about a minute.
- L5 T2 done. S2 kept fail-closed and pinned with a test, and the reason is written on persistCrisisExchange. S3: only "ataque(s)/crisis de pánico" match. S4: "deprimid", "no puedo dormir", "insomnio" and common psychiatric drugs. Matching is accent-insensitive. S6: the referral text is built from CLINICAL_REFERRAL_MARKER, so the behavior is unchanged. Differential check of isClinicalQuestion against the base over 31 phrases: only "me da pánico" (now false) and the four new phrases (now true) differ. Risk: none (requested change to a shared helper, covered by tests).
