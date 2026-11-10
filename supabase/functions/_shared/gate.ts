// supabase/functions/_shared/gate.ts
// Sender admission gate: sender rights (BAJA, ELIMINAR), rate limiting, and informed,
// versioned opt-in consent.
//
// The business number answers any sender that reaches it, so this module decides what
// a given sender is allowed to cost before the webhook spends anything. It answers one
// question and returns one discriminated union, so the webhook cannot acknowledge a
// branch it forgot to handle.

import { greetingResponse, routeDeterministicMessage } from './router.ts';
import {
  consumeRateLimitSlot,
  eraseSenderData,
  getSenderConsentState,
  recordConsentPromptShown,
  recordSenderConsent,
  revokeSenderConsent,
} from './supabase.ts';
import { ConsentPolicy, Psicologo } from './types.ts';
import { normalizePhoneNumber, sanitizeInput } from './validation.ts';

// ---------------------------------------------------------------------------
// Tunable product defaults
//
// Every value in this block is a product default rather than a verified requirement,
// isolated here so it can be retuned without touching any logic below. Changing a
// ceiling or a token changes only the gate's decisions, never the pipeline a
// consented sender traverses.
// ---------------------------------------------------------------------------

// Ceiling for a sender who has NOT opted in, per hour.
//
// Tradeoff: this path makes no Claude call and writes no history, so a high ceiling
// costs almost nothing directly, and the number only bounds how much volume an
// arbitrary number can push through deterministic answers and outbound WhatsApp
// messages. It is set low because it is a pure abuse brake and a prospective patient
// needs a handful of messages, not dozens, to ask about price, hours and address.
export const NON_CONSENTED_HOURLY_CEILING = 10;

// Ceiling for a sender who HAS opted in, per hour.
//
// Tradeoff: this path does call Claude, so the ceiling is the real cost control, but
// a live therapy conversation is long and pauses are normal. Set far above the
// unconsented ceiling so a genuine session is never truncated mid-exchange; it exists
// to stop runaway loops, not to ration a conversation.
export const CONSENTED_HOURLY_CEILING = 60;

// One fixed window. A fixed window rather than a sliding one because a sliding window
// needs the caller's whole recent history to evaluate, which would add a read to the
// hot path to protect a path that is already bounded by the ceiling above. The cost is
// a sender near the boundary can send twice the ceiling across two adjacent windows,
// which is an acceptable trade for a single atomic statement.
export const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

// The only opt-in word, compared after uppercasing, accent stripping and whitespace
// collapsing. Health data needs explicit consent, so a short reply that can appear
// incidentally ("ok", "si") must never count as one, and the consent text names this
// exact word.
export const OPT_IN_TOKENS: readonly string[] = ['ACEPTO'];

// Rights requests, matched the same way. They are the words the consent text names.
export const REVOKE_TOKEN = 'BAJA';
export const ERASE_TOKEN = 'ELIMINAR';

// ---------------------------------------------------------------------------
// Responses
//
// Written in the same register as UNAVAILABLE_RESPONSE, MEDIA_RESPONSE and
// CRISIS_RESPONSE in supabase/functions/webhook/index.ts. Each is a Spanish
// user-facing string and deliberately not a generated answer.
// ---------------------------------------------------------------------------

// Served when no consent policy is published: nobody can consent, so the sender is
// told what the bot can still answer instead of being asked for a consent it cannot
// record.
export const CONSENT_UNAVAILABLE_NOTICE =
  'Por ahora solo puedo responder consultas sobre precios, horarios, ubicación y cómo agendar una cita.';

export const RATE_LIMIT_RESPONSE =
  'Recibí demasiados mensajes en la última hora. Por favor, intenta de nuevo más tarde. Si necesitas hablar con tu psicólogo/a, comunícate directamente.';

export const OPT_IN_CONFIRMED_NOTICE =
  'Listo, registré tu autorización. Ya puedo responder consultas abiertas y recordar esta conversación. Recuerda que este canal es automático y nadie lo lee. Escribe BAJA para retirar tu autorización o ELIMINAR para borrar tu historial.';

// Served instead of the confirmation when the consent write failed, so the sender is
// never told a consent that was not stored and cannot tell that apart from being ignored.
export const OPT_IN_FAILED_NOTICE =
  'No pude registrar tu autorización en este momento. Por favor, intenta de nuevo más tarde.';

// Served when the consent state could not be read. The sender is kept on the
// deterministic path, and told it is temporary rather than that consent is unavailable.
export const CONSENT_CHECK_FAILED_NOTICE =
  'No pude verificar tu autorización en este momento, así que por ahora solo puedo responder consultas sobre precios, horarios, ubicación y cómo agendar una cita. Por favor, intenta de nuevo más tarde.';

export const REVOKED_NOTICE =
  'Listo, retiré tu autorización. Ya no guardaré esta conversación ni responderé consultas abiertas. Si quieres borrar también tu historial, escribe ELIMINAR.';

export const NOTHING_TO_REVOKE_NOTICE =
  'No tenías una autorización activa, así que no hay nada que retirar. Si quieres borrar los datos asociados a tu número, escribe ELIMINAR.';

export const ERASED_NOTICE =
  'Listo, borré tu historial y los datos asociados a tu número, y retiré tu autorización si la tenías. Solo conservo la constancia de tus autorizaciones, como respaldo.';

// Served when a BAJA or ELIMINAR could not be processed, so the sender is never told a
// right was exercised when it was not.
export const RIGHTS_FAILED_NOTICE =
  'No pude procesar tu solicitud en este momento. Por favor, intenta de nuevo más tarde.';

// Served to a CONSENTED sender when the rate-limit counter could not be read or
// written. For a consented sender the counter is the only per-sender ceiling on Claude
// spend, so letting the message through on a null count would remove the cost bound
// entirely for exactly the sender who can spend the most. Saying so honestly is
// better than serving unbounded generated answers.
export const DEGRADED_SERVICE_RESPONSE =
  'No puedo verificar tu límite de mensajes en este momento, así que pausé la conversación por seguridad. Por favor, intenta de nuevo más tarde o comunícate directamente con tu psicólogo/a.';

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Why the gate allowed a message through.
 * - consented: the sender already opted in for this psychologist.
 */
export type GateAllowReason = 'consented';

export type GateDecision =
  /** Continue into the full existing pipeline, unchanged. Carries no reply. */
  | { outcome: 'allow'; reason: GateAllowReason }
  /**
   * A BAJA or ELIMINAR was handled (or honestly failed). Send `response` and mark
   * completed. No Claude, no history.
   */
  | { outcome: 'rights'; response: string }
  /** Sender is over the ceiling. Send `response` and mark completed. No retry. */
  | { outcome: 'rate_limited'; response: string }
  /**
   * Consent was recorded. Send `response` and mark completed. No Claude, no write.
   */
  | { outcome: 'optin_confirmed'; response: string }
  /** Unconsented and not opting in. Send `response` and mark completed. */
  | { outcome: 'limited'; response: string }
  /**
   * Consented, but the rate-limit counter could not be read or written. Send `response`
   * and mark completed: the conversation is paused rather than run with no cost bound.
   */
  | { outcome: 'degraded'; response: string };

export interface GateDependencies {
  getSenderConsentState: typeof getSenderConsentState;
  recordConsentPromptShown: typeof recordConsentPromptShown;
  recordSenderConsent: typeof recordSenderConsent;
  revokeSenderConsent: typeof revokeSenderConsent;
  eraseSenderData: typeof eraseSenderData;
  consumeRateLimitSlot: typeof consumeRateLimitSlot;
}

const defaultDependencies: GateDependencies = {
  getSenderConsentState,
  recordConsentPromptShown,
  recordSenderConsent,
  revokeSenderConsent,
  eraseSenderData,
  consumeRateLimitSlot,
};

/**
 * Normalize a sender's message for opt-in token comparison.
 *
 * Implemented locally rather than reused: validation.ts has no exported generic
 * normalizer. isCrisisSignal normalizes for accent-insensitive keyword SEARCH and
 * lowercases, which is the wrong shape for matching a fixed phrase, and sanitizeInput
 * collapses whitespace but neither strips accents nor changes case. Matching against
 * this normalized form is the only thing OPT_IN_TOKENS is compared against.
 */
function normalizeForTokenMatch(value: string): string {
  return value
    .toUpperCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    // A period or exclamation marks ("BAJA.", "¡acepto!") do not change the word, but
    // a question mark does: "¿Acepto?" asks what accepting means and is not consent.
    .replace(/^[¡!.\s]+|[!.\s]+$/g, '');
}

const NORMALIZED_OPT_IN_TOKENS = new Set(OPT_IN_TOKENS.map(normalizeForTokenMatch));

/** Whether a message is an explicit opt-in, compared case- and accent-insensitively. */
export function isOptInToken(value: string): boolean {
  return NORMALIZED_OPT_IN_TOKENS.has(normalizeForTokenMatch(value));
}

/**
 * Start of the fixed window a message belongs to: now floored to the window boundary.
 *
 * Flooring is what makes the counter a single atomic statement. Every message in the
 * same hour produces the identical value, so every one of them contends for one row
 * keyed by that value, and the increment serializes on that row. Passing an unfloored
 * timestamp would give every message its own bucket and the ceiling would never apply.
 */
export function rateLimitWindowStart(now: number = Date.now()): string {
  return new Date(Math.floor(now / RATE_LIMIT_WINDOW_MS) * RATE_LIMIT_WINDOW_MS).toISOString();
}

/** The full consent text of a policy, rendered for this psychologist, with its link. */
export function renderConsentRequest(policy: ConsentPolicy, psicologo: Psicologo): string {
  const text = policy.texto.replaceAll('{profesional}', psicologo.nombre);
  return `${text}\n\nPolítica de privacidad completa: ${policy.url}`;
}

/** The short reminder served once the full consent text has already been shown. */
export function consentReminder(policy: ConsentPolicy): string {
  return `Para que pueda responder consultas abiertas, responde ACEPTO. Antes, revisa la política de privacidad: ${policy.url}`;
}

/** The deterministic answer, or the greeting, when nothing deterministic matched. */
function deterministicAnswer(cleanMessage: string, psicologo: Psicologo): string {
  // A message with no deterministic match, and an empty message, both land on the
  // greeting: it names exactly what the sender may ask about, which is the listing
  // information a prospective patient needs, and it makes no Claude call.
  return (routeDeterministicMessage(cleanMessage, psicologo) ?? greetingResponse(psicologo)).contenido;
}

/**
 * Decide what a sender is allowed to reach, in a fixed order.
 *
 * Crisis signals never reach this gate: the webhook answers them first, ahead of the
 * rate limit, consent, and every other database read (see handleCrisisMessage).
 *
 * @param rawText   The inbound message text, sanitized here before any decision.
 * @param senderNumber The sender's WhatsApp number; normalized once and used as the
 *                   consent and rate-limit key for every branch below, so the gate can
 *                   never consult two different identities for one sender.
 * @param psicologo  The resolved profile, used for the reply copy and as the tenant
 *                   that consent and the rate limit are scoped to.
 * @param wamid      The inbound message id, recorded with every consent decision so it
 *                   can be traced to the message that carried it.
 */
export async function evaluateGate(
  rawText: string,
  senderNumber: string,
  psicologo: Psicologo,
  wamid: string,
  dependencies: GateDependencies = defaultDependencies
): Promise<GateDecision> {
  const cleanMessage = sanitizeInput(rawText);

  // One identity for consent and for the rate limit, both scoped to this psychologist.
  const senderKey = normalizePhoneNumber(senderNumber);

  // 0. Rights requests, before the rate limit and before consent: exercising a right
  //    must never depend on having consented or on how many messages were sent.
  const command = normalizeForTokenMatch(cleanMessage);
  if (command === REVOKE_TOKEN) {
    const revoked = await dependencies.revokeSenderConsent(psicologo.id, senderKey, wamid);
    const response =
      revoked === null ? RIGHTS_FAILED_NOTICE : revoked ? REVOKED_NOTICE : NOTHING_TO_REVOKE_NOTICE;
    return { outcome: 'rights', response };
  }
  if (command === ERASE_TOKEN) {
    // true or false only says whether a consent was also withdrawn; the reply is the
    // same, because the data was erased either way. null means nothing was erased.
    const consentWithdrawn = await dependencies.eraseSenderData(
      psicologo.id,
      senderKey,
      wamid,
      rateLimitWindowStart()
    );
    return {
      outcome: 'rights',
      response: consentWithdrawn === null ? RIGHTS_FAILED_NOTICE : ERASED_NOTICE,
    };
  }

  const consentState = await dependencies.getSenderConsentState(psicologo.id, senderKey);
  const { consented, policy } = consentState;

  // 1. Rate limit. The ceiling depends on consent state, so consent is resolved first
  //    even though deciding to charge a slot is not what makes a sender "consented".
  const ceiling = consented ? CONSENTED_HOURLY_CEILING : NON_CONSENTED_HOURLY_CEILING;
  const messageCount = await dependencies.consumeRateLimitSlot(
    psicologo.id,
    senderKey,
    rateLimitWindowStart()
  );

  // A null count means the counter could not be read or written. What to do about that
  // DEPENDS ON THE CONSENT STATE, because the rate limit is not equally important to
  // both classes of sender:
  //
  // - Unconsented: failing open costs nothing. This path makes no Claude call and
  //   writes no history, so the worst an outage buys an attacker is extra deterministic
  //   answers. Failing closed here would deny a prospective patient basic information.
  // - Consented: failing open removes the ONLY per-sender ceiling on Claude spend,
  //   for the one sender who can spend the most. During a sustained database,
  //   permission, or missing-function outage that is unbounded spend, so the message is
  //   answered honestly and the conversation is paused instead.
  //
  // Consent is resolved before this point precisely so this branch can tell the two
  // cases apart. Do not collapse them back into a single null-tolerant comparison.
  if (messageCount === null) {
    if (consented) {
      return { outcome: 'degraded', response: DEGRADED_SERVICE_RESPONSE };
    }
  } else if (messageCount > ceiling) {
    return { outcome: 'rate_limited', response: RATE_LIMIT_RESPONSE };
  }

  // 2. Consented to the policy in force: the full existing pipeline, unchanged.
  if (consented) {
    return { outcome: 'allow', reason: 'consented' };
  }

  const answer = deterministicAnswer(cleanMessage, psicologo);

  // 3a. The consent state could not be read: say so, and ask nothing.
  if (consentState.lookupFailed) {
    return { outcome: 'limited', response: `${answer}\n\n${CONSENT_CHECK_FAILED_NOTICE}` };
  }

  // 3b. No published policy: nobody can consent, so no consent is requested either.
  if (!policy) {
    return { outcome: 'limited', response: `${answer}\n\n${CONSENT_UNAVAILABLE_NOTICE}` };
  }

  // 4. Explicit opt-in, honored only after the sender was shown THIS policy's text.
  //    Consent to a text nobody saw is not informed, so an ACEPTO that arrives first
  //    gets the full text instead. No Claude call and no conversation row.
  //
  //    The write result decides the reply: a failed write reports as `limited` with an
  //    honest reason, never a confirmation that did not happen. A refusal means the
  //    shown text was erased (an ELIMINAR landed first), so the full text is shown again.
  let promptShown = consentState.promptShown;
  if (isOptInToken(cleanMessage) && promptShown) {
    const recorded = await dependencies.recordSenderConsent(psicologo.id, senderKey, policy.version, wamid);
    if (recorded === null) {
      return {
        outcome: 'limited',
        response: `${OPT_IN_FAILED_NOTICE}\n\n${consentReminder(policy)}`,
      };
    }
    if (recorded) {
      return {
        outcome: 'optin_confirmed',
        response: `${OPT_IN_CONFIRMED_NOTICE}\n\n${greetingResponse(psicologo).contenido}`,
      };
    }
    promptShown = false;
  }

  // 5. Unconsented: the deterministic answer plus the consent request. The full text
  //    the first time for this policy, a short reminder after that. No Claude, no
  //    history, no conversation row. A failed prompt record only means the full text
  //    is shown again next time, so it never changes the reply.
  if (promptShown) {
    return { outcome: 'limited', response: `${answer}\n\n${consentReminder(policy)}` };
  }
  await dependencies.recordConsentPromptShown(psicologo.id, senderKey, policy.version, wamid);
  return {
    outcome: 'limited',
    response: `${answer}\n\n${renderConsentRequest(policy, psicologo)}`,
  };
}
