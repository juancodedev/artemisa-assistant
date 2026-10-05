// supabase/functions/_shared/gate.ts
// Sender admission gate: crisis handling, rate limiting, and explicit opt-in consent.
//
// The business number answers any sender that reaches it, so this module decides what
// a given sender is allowed to cost before the webhook spends anything. It answers one
// question and returns one discriminated union, so the webhook cannot acknowledge a
// branch it forgot to handle.

import { greetingResponse, routeDeterministicMessage } from './router.ts';
import {
  consumeRateLimitSlot,
  hasSenderConsent,
  recordSenderConsent,
} from './supabase.ts';
import { Psicologo } from './types.ts';
import { isCrisisSignal, normalizePhoneNumber, sanitizeInput } from './validation.ts';

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

// Opt-in phrases, compared after uppercasing, accent stripping and whitespace
// collapsing. "SI" is included without an accent because an accented "SÍ" collapses to
// it and an unaccented "SI" is a legitimate typo of the same answer.
//
// Tradeoff: "OK" and "SI" are short enough to appear incidentally in an unrelated
// message, which would record a consent nobody meant to give. They are kept because
// the cost of that mistake is one row that a DELETE revokes, while the cost of NOT
// recognizing a plainly consenting sender is that they are stuck on the deterministic
// path with no way to explain why. Deliberately absent: "hola", which must stay an
// ordinary greeting, and any free-text form, because a consent prompt that accepts
// anything is not consent.
export const OPT_IN_TOKENS: readonly string[] = ['QUIERO', 'SI', 'ACCEPTO', 'OK', 'DE ACUERDO'];

// ---------------------------------------------------------------------------
// Responses
//
// Written in the same register as UNAVAILABLE_RESPONSE, MEDIA_RESPONSE and
// CRISIS_RESPONSE in supabase/functions/webhook/index.ts. Each is a Spanish
// user-facing string and deliberately not a generated answer.
// ---------------------------------------------------------------------------

export const CONSENT_REQUEST =
  'Para responderte consultas abiertas y recordar esta conversación necesito tu consentimiento. Respondé QUIERO para aceptarlo. Mientras tanto podés consultarme por precios, horarios, ubicación y cómo agendar una cita.';

export const RATE_LIMIT_RESPONSE =
  'Recibí demasiados mensajes en la última hora. Por favor intentá de nuevo en un rato. Si necesitás hablar con tu psicólogo/a, podés contactarlo/la directamente.';

export const OPT_IN_CONFIRMED_NOTICE =
  'Perfecto, registré tu consentimiento. Ya puedo responderte consultas abiertas y recordar esta conversación.';

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Why the gate allowed a message through.
 * - crisis:   a crisis signal, which is never gated (see evaluateGate).
 * - consented: the sender already opted in for this psychologist.
 */
export type GateAllowReason = 'crisis' | 'consented';

export type GateDecision =
  /** Continue into the full existing pipeline, unchanged. Carries no reply. */
  | { outcome: 'allow'; reason: GateAllowReason }
  /** Sender is over the ceiling. Send `response` and mark completed. No retry. */
  | { outcome: 'rate_limited'; response: string }
  /** Consent was recorded. Send `response` and mark completed. No Claude, no write. */
  | { outcome: 'optin_confirmed'; response: string }
  /** Unconsented and not opting in. Send `response` and mark completed. */
  | { outcome: 'limited'; response: string };

export interface GateDependencies {
  hasSenderConsent: typeof hasSenderConsent;
  recordSenderConsent: typeof recordSenderConsent;
  consumeRateLimitSlot: typeof consumeRateLimitSlot;
}

const defaultDependencies: GateDependencies = {
  hasSenderConsent,
  recordSenderConsent,
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
    .trim();
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

/** The deterministic answer, or the greeting, followed by the explicit consent request. */
function limitedResponse(cleanMessage: string, psicologo: Psicologo): string {
  // A message with no deterministic match, and an empty message, both land on the
  // greeting: it names exactly what the sender may ask about, which is the listing
  // information a prospective patient needs, and it makes no Claude call.
  const base = routeDeterministicMessage(cleanMessage, psicologo) ?? greetingResponse(psicologo);
  return `${base.contenido}\n\n${CONSENT_REQUEST}`;
}

/**
 * Decide what a sender is allowed to reach, in a fixed order.
 *
 * WHY CRISIS IS EVALUATED FIRST, BEFORE THE RATE LIMIT AND BEFORE CONSENT
 * 1. The crisis branch makes no Claude call. It is a string comparison against a
 *    keyword list plus a constant response, so gating it protects no budget at all.
 * 2. Gating it would create real, concrete harm. A person writing for the first time
 *    about killing themselves and receiving "respondé QUIERO" instead of the
 *    suicide-prevention line would be sent away from the only help offered.
 * 3. The cost of putting it first is therefore close to zero, while the cost of putting
 *    it anywhere later is a life-safety regression.
 * Because a person in crisis is exactly the person most likely to send several
 * messages in a row, this ordering also means the rate limit can never be what stands
 * between that person and the crisis response. DO NOT "optimize" this check into a
 * later branch: it is a safety ordering, not a performance choice.
 *
 * @param rawText    The inbound message text, sanitized here before any decision.
 * @param senderNumber The sender's WhatsApp number; normalized once and used as the
 *                   consent and rate-limit key for every branch below, so the gate can
 *                   never consult two different identities for one sender.
 * @param psicologo  The resolved profile, used for the reply copy and as the tenant
 *                   that consent and the rate limit are scoped to.
 */
export async function evaluateGate(
  rawText: string,
  senderNumber: string,
  psicologo: Psicologo,
  dependencies: GateDependencies = defaultDependencies
): Promise<GateDecision> {
  const cleanMessage = sanitizeInput(rawText);

  // 1. Crisis. Never gated. See the ordering note above.
  if (isCrisisSignal(cleanMessage)) {
    return { outcome: 'allow', reason: 'crisis' };
  }

  // One identity for consent and for the rate limit, both scoped to this psychologist.
  const senderKey = normalizePhoneNumber(senderNumber);
  const consented = await dependencies.hasSenderConsent(psicologo.id, senderKey);

  // 2. Rate limit. The ceiling depends on consent state, so consent is resolved first
  //    even though deciding to charge a slot is not what makes a sender "consented".
  const ceiling = consented ? CONSENTED_HOURLY_CEILING : NON_CONSENTED_HOURLY_CEILING;
  const messageCount = await dependencies.consumeRateLimitSlot(
    psicologo.id,
    senderKey,
    rateLimitWindowStart()
  );

  // FAIL OPEN, deliberately. A null count means the counter could not be read or
  // written, and this gate lets the message through rather than denying it. The reason
  // this is safe is that the rate limit is only a volume brake: the path it protects for
  // an unconsented sender is deterministic, writes nothing, and costs no Claude call, so
  // the worst a counter outage buys an attacker is extra local answers. Failing closed
  // instead would deny service to an already-consented patient during a transient
  // database blip, which is a real patient losing access to their psychologist.
  // See consumeRateLimitSlot for the same tradeoff stated at the source.
  if (messageCount !== null && messageCount > ceiling) {
    return { outcome: 'rate_limited', response: RATE_LIMIT_RESPONSE };
  }

  // 3. Consented: the full existing pipeline, unchanged.
  if (consented) {
    return { outcome: 'allow', reason: 'consented' };
  }

  // 4. Explicit opt-in. Consent is recorded, then confirmed with the greeting. No
  //    Claude call and no conversation row: the greeting is fully self-contained, so
  //    nothing is lost by not persisting the token that granted consent.
  if (isOptInToken(cleanMessage)) {
    await dependencies.recordSenderConsent(psicologo.id, senderKey);
    return {
      outcome: 'optin_confirmed',
      response: `${OPT_IN_CONFIRMED_NOTICE}\n\n${greetingResponse(psicologo).contenido}`,
    };
  }

  // 5. Unconsented and not opting in: the deterministic answer plus the consent
  //    request. No Claude, no history, no conversation row.
  return { outcome: 'limited', response: limitedResponse(cleanMessage, psicologo) };
}