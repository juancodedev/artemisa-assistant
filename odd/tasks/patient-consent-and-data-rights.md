# Patient consent and data rights before offering Artemisa to a health center

Objective: safe crisis handling, informed versioned consent, patient data rights, and retention.
Branch: `feat/patient-consent-and-data-rights`. Delivery: `single-pr` (the user asked for "el pr").
Test runner: `deno test` over `supabase/functions/_shared/phase1.test.ts`; SQL verified against a disposable Postgres container.

## Specs

- S1 Crisis: "ampliar la detección con patrones y tests de frases reales, y no guardar nada si no hay consentimiento." The crisis line is sent even when the database fails.
- S2 Promise: "sacar la promesa". The bot "responderá las preguntas, no que este notificará, por lo menos por ahora". No professional notification is built.
- S3 Consent: "Consentimiento versionado: una tabla de versiones de la política y un registro de eventos que no se borre (aceptó/revocó, versión, wamid). Palabra exacta ACEPTO, y pedirlo de nuevo si cambia la política." Record that the text was shown; existing consents must accept again; the consent text states that nobody monitors the channel.
- S4 Rights: "BAJA y ELIMINAR por WhatsApp, y borrado automático por plazo con pg_cron." Commands run after crisis and before the rate limit. `ELIMINAR` keeps only the consent proof. Plazo: "90 dias". The first purge run requires the user's confirmation, so applying the migrations must not schedule it.
- S5 Minimization: "ocultar también el texto clínico y no mandarlo a Claude."
- S6 Language and country: "primer pais, Chile"; "los textos, si, en español neutro". Applies to patient-facing strings in the deployed runtime.

## Tasks

| ID | Specs | Route | Status | Commit |
| --- | --- | --- | --- | --- |
| T1 Crisis detection and unconditional reply | S1 | inline | done: RED 3 failed, GREEN 42 passed | see Log L5 |
| T2 Remove the promise, neutral Spanish | S2, S6 | inline | done: RED 3 failed, GREEN 43 passed | see Log L6 |
| T3 Clinical minimization | S5 | inline | done: RED 2 failed, GREEN 46 passed | see Log L8 |
| T4 Versioned consent | S3, S6 | inline | pending | |
| T5 BAJA, ELIMINAR, retention purge | S4 | inline | pending | |

Route evidence: no Writer trigger; units depend on each other and share `gate.ts`, `webhook/index.ts`, and the test file.

## Log

- L1 (2026-11-09, user request, verbatim): "1. Crisis: ampliar la detección con patrones y tests de frases reales, y no guardar nada si no hay consentimiento. 2. Avisos: notificar de verdad al profesional, o sacar la promesa. 3. Consentimiento versionado: una tabla de versiones de la política y un registro de eventos que no se borre (aceptó/revocó, versión, wamid). Palabra exacta ACEPTO, y pedirlo de nuevo si cambia la política. 4. Derechos del paciente: BAJA y ELIMINAR por WhatsApp, y borrado automático por plazo con pg_cron. 5. Minimización: ocultar también el texto clínico y no mandarlo a Claude."
- L2 (2026-11-09, user, verbatim): "los mensajes seran desde los usuarios al bot, no en la otra direccion, está pensando como una secretaria del psicologo que responderá las preguntas, no que este notificará , por lo menos pora ahora"
- L3 (2026-11-09, user, verbatim): "primer pais, Chile / Borrado, 90 dias está bien / los textos, si, en español neutro la verdad / procede e implementa el pr"
- L4 Baseline: 39 Edge tests pass on `58220ef` with Deno 2.1.10 installed outside the repository.
- L5 T1: real phrasings ("me quiero matar", "me voy a suicidar") were missed; patterns now cover them. The webhook sends the crisis line before the profile lookup, the rate limit, and consent, and through claim, profile, and conversation outages. The redacted exchange is stored only for a consented sender. RED 3 failed; GREEN 42 passed; `deno check` clean.
- L6 T2: the four replies that promised a follow-up ("te contactará a la brevedad", "revisará tu consulta", "te responderá") now point to a channel that reaches a person. One `CLINICAL_REFERRAL_RESPONSE` serves both the router and Claude's prompt. Patient-facing strings in `supabase/functions/` are neutral Spanish; the consent strings are rewritten in T4. `src/` is the undeployed legacy tree and stays unchanged. RED 3 failed; GREEN 43 passed; Node tests 13 passed.
- L7 Review of `cd7e437` (lenses risk, resilience, reliability): approved and acknowledged, with non-blocking advisories. Acted on two: "me mato" and "terminar/acabar con todo" now match only when they end the thought, so "me mato estudiando" and "terminar con todo el papeleo" reach the ordinary pipeline; a failed crisis send is pinned to request redelivery. Accepted trade-offs: a crisis message skips the rate limit, and a redelivery after an uncertain claim repeats the helpline. RED 1 failed; GREEN 44 passed.
- L8 T3: patient text is stored as a marker when routing classified it as crisis or clinical, or when its wording is clinical inside another route (for example a scheduling request). History sent to Claude is redacted again at the only Claude boundary, which covers rows stored before this change. The clinical keyword 'ataque de pánico' missed the plural, so the keyword is now 'pánico'. Limit: detection is the keyword heuristic, so a clinical message it misses is still stored and can reach Claude. RED 2 failed; GREEN 46 passed.
