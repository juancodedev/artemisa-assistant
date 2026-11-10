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
| T3 | S5, S7 (cron/docs) | inline | done | Deno 62/62, SQL exit 0. S5 is a refactor (tests pin the words; no RED possible) |

## Log

- L1 (2026-11-10) User: "vamos con el punto 2, el issue 7".
- L2 Design: migration 009 adds `record_sender_consent` (same advisory lock as 008, requires the prompt row of the active policy), drops the direct `INSERT` of `service_role` on `consent_events` so the lock cannot be bypassed, replaces the 2-hour literal in `erase_sender_data` with the current rate window passed by the Edge Function, and revokes the sequence grant. Clinical matching becomes accent-insensitive. The publish step gains a check that a published policy names ACEPTO, BAJA and ELIMINAR.
- L3 T1 done. S8 folded into T1 because the renamed line is the one that now passes the window. S9 also done in T1: the purge test asserts lower bounds plus the rows themselves. A refused ACEPTO (prompt erased) shows the full consent text again and records the prompt. Risk: item 2 (consent_events and sequence grants) and item 3 (erase_sender_data signature, consumed only by the webhook).
- L4 T1 review (lineage review-cfaaaf5ce650e739): approved with informational warnings and acknowledged. Follow-up: erase_sender_data now takes the per-sender lock itself (R3-003); the documented UPDATE publish flow is tested against the new constraint (R3-002); production holds only the unpublished draft, which names the three words, so the constraint cannot abort 009 there (R4). Accepted: ACEPTO and ELIMINAR fail honestly between applying 009 and deploying the webhook; the policy is unpublished, so only ELIMINAR is exposed, for about a minute.
- L5 T2 done. S2 kept fail-closed and pinned with a test, and the reason is written on persistCrisisExchange. S3: only "ataque(s)/crisis de pánico" match. S4: "deprimid", "no puedo dormir", "insomnio" and common psychiatric drugs. Matching is accent-insensitive. S6: the referral text is built from CLINICAL_REFERRAL_MARKER, so the behavior is unchanged. Differential check of isClinicalQuestion against the base over 31 phrases: only "me da pánico" (now false) and the four new phrases (now true) differ. Risk: none (requested change to a shared helper, covered by tests).
- L6 Review of 629d104..6a106a5 (lineage review-0048eae5fbac1b46): approved and acknowledged. Warnings acted on in T3: "siento/tengo pánico" and "trastorno de pánico" count as clinical again (R1-001, R3-001; test written after the fix, which HEAD fails by construction); the test that injects a Claude client restores it in `finally` (R3-002); the publish test asserts the row is published (R3-004). R3-003 (lock key) verified by reading: all three functions use `hashtextextended(psicologo_id::text || '|' || numero, 0)`.
- L7 T3 done. Replies are built from OPT_IN_TOKENS, REVOKE_TOKEN and ERASE_TOKEN; the policy text is covered by the 009 constraint. The cron job calls purge_expired_personal_data() with no argument, so the 90 days live in the function default and in the consent text, and docs/09 says both must change together. The production job (jobid 1) still passes interval '90 days' explicitly, which is equivalent; re-running the script would replace it. Risk: none.
- L8 Review of 629d104..07dbad9 (lineage review-9ed594204cd0ee40, run because the Stop hook offered the accumulated range): approved and acknowledged. Follow-ups: "pánico" is clinical in any form except the everyday "(me) da pánico" (R1-001, R3-001; HEAD 07dbad9 fails "tengo mucho pánico"); retention comments corrected and docs/09 says to re-run the script (R2-001, R2-002); the marker comparison is case-insensitive (R2-003); the SQL test pins the 90-day default (R3-003). R3-002: 009 was never applied anywhere, so editing it in place is safe; the lock's concurrency is left to the independent verifier.
- L9 PR #10 opened (Closes #7). Verifier: S1-S10 met, no blockers. Deploy after merge: apply 009, then deploy webhook immediately.
- L10 Review of 629d104..HEAD (lineage review-3a27ad58eb363473): approved and acknowledged. Fixed R2-002/R3-001: one everyday "me da pánico" hid another panic mention in the same message (RED: 'me da pánico salir porque tengo ataques de pánico'); the everyday phrases are now removed before looking for panic. R2-001: the marker moved above the JSDoc of CLINICAL_REFERRAL_RESPONSE. R1-001 accepted: "me da pánico salir de casa" is not flagged, the trade-off S3 asked for.
