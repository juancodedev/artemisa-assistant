// supabase/functions/webhook/index.ts
// Main entry point for the Meta WhatsApp Business Cloud API webhook.

import {
  handleWebhookVerification,
  parseWebhookPayload,
  sendMessage,
  verifyMetaSignature,
  type WebhookMessage,
} from '../_shared/whatsapp.ts';
import {
  appendMessagesToConversacion,
  claimIncomingMessage,
  completeIncomingMessage,
  consumeRateLimitSlot,
  failIncomingMessage,
  getBoundedHistory,
  getOrCreateConversacion,
  getPsicologo,
  hasSenderConsent,
  markDeliveryUncertain,
  recordSenderConsent,
} from '../_shared/supabase.ts';
import { processIncomingMessage } from '../_shared/bot.ts';
import { evaluateGate } from '../_shared/gate.ts';
import { CRISIS_RESPONSE } from '../_shared/router.ts';
import { isCrisisSignal, normalizePhoneNumber, sanitizeInput } from '../_shared/validation.ts';
import { aggregateBatchOutcomes, type BatchMessageOutcome } from '../_shared/batch.ts';

const UNAVAILABLE_RESPONSE =
  'En este momento el servicio está temporalmente no disponible. Por favor contactá a tu profesional directamente.';
const MEDIA_RESPONSE =
  'Por el momento solo puedo procesar mensajes de texto. Para enviarme audios o documentos, por favor contactá directamente a tu psicólogo/a.';
const CRISIS_USER_MESSAGE_PLACEHOLDER = '[mensaje de crisis omitido]';

export interface WebhookDependencies {
  claimIncomingMessage: typeof claimIncomingMessage;
  sendMessage: typeof sendMessage;
  getPsicologo: typeof getPsicologo;
  getOrCreateConversacion: typeof getOrCreateConversacion;
  getBoundedHistory: typeof getBoundedHistory;
  processIncomingMessage: typeof processIncomingMessage;
  appendMessagesToConversacion: typeof appendMessagesToConversacion;
  completeIncomingMessage: typeof completeIncomingMessage;
  failIncomingMessage: typeof failIncomingMessage;
  markDeliveryUncertain: typeof markDeliveryUncertain;
  // The gate and the three data-access helpers it composes are injected separately on
  // purpose: a test can override evaluateGate alone to pin a decision, or override only
  // the three helpers to drive the real gate logic end to end through this handler.
  evaluateGate: typeof evaluateGate;
  hasSenderConsent: typeof hasSenderConsent;
  recordSenderConsent: typeof recordSenderConsent;
  consumeRateLimitSlot: typeof consumeRateLimitSlot;
}

const defaultDependencies: WebhookDependencies = {
  claimIncomingMessage,
  sendMessage,
  getPsicologo,
  getOrCreateConversacion,
  getBoundedHistory,
  processIncomingMessage,
  appendMessagesToConversacion,
  completeIncomingMessage,
  failIncomingMessage,
  markDeliveryUncertain,
  evaluateGate,
  hasSenderConsent,
  recordSenderConsent,
  consumeRateLimitSlot,
};

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function markMessageCompleted(
  wamid: string,
  dependencies: WebhookDependencies,
  errorCode: 'persistence_failed' | null = null
): Promise<'completed' | 'retry'> {
  if (await dependencies.completeIncomingMessage(wamid, errorCode)) return 'completed';
  try {
    await dependencies.failIncomingMessage(wamid, 'processing_failed');
  } catch {
    console.error('Unable to preserve retryable inbound message state');
  }
  return 'retry';
}

async function handleDeliveryResult(
  result: Awaited<ReturnType<typeof sendMessage>>,
  wamid: string,
  dependencies: WebhookDependencies
): Promise<BatchMessageOutcome | null> {
  if (result.success) return null;

  if (result.delivery === 'uncertain') {
    // Meta may have accepted the request even though the response was lost or incomplete.
    // The accepted-but-response-lost window cannot provide exactly-once delivery.
    if (await dependencies.markDeliveryUncertain(wamid)) return 'delivery_uncertain';
    return 'retry';
  }

  // A definite non-2xx response is safe to retry.
  await dependencies.failIncomingMessage(wamid, 'delivery_failed');
  return 'retry';
}

/**
 * Store a redacted crisis exchange, only for a sender who consented to history.
 * Runs after delivery, so a failure here can never cost the sender the crisis line.
 * Returns false only when a consented exchange could not be stored.
 */
async function persistCrisisExchange(
  message: WebhookMessage,
  dependencies: WebhookDependencies
): Promise<boolean> {
  try {
    const psicologo = await dependencies.getPsicologo(message.phoneNumberId);
    if (!psicologo) return true;

    const senderKey = normalizePhoneNumber(message.from);
    if (!(await dependencies.hasSenderConsent(psicologo.id, senderKey))) return true;

    const conversation = await dependencies.getOrCreateConversacion(psicologo.id, senderKey);
    if (!conversation) return false;

    const timestamp = new Date().toISOString();
    return await dependencies.appendMessagesToConversacion(conversation.id, conversation.historial, [
      { role: 'user', content: CRISIS_USER_MESSAGE_PLACEHOLDER, timestamp },
      { role: 'assistant', content: CRISIS_RESPONSE, timestamp },
    ]);
  } catch {
    console.error('Crisis exchange persistence failed after WhatsApp delivery');
    return false;
  }
}

/**
 * Send the crisis line before anything that depends on the database.
 *
 * This is a safety ordering, not a performance choice. The crisis branch runs ahead of
 * the profile lookup, the rate limit, and consent, so none of them, and no outage in
 * any of them, can stand between a person in crisis and the helpline.
 */
async function handleCrisisMessage(
  message: WebhookMessage,
  claim: 'claimed' | 'uncertain',
  dependencies: WebhookDependencies
): Promise<BatchMessageOutcome> {
  const deliveryOutcome = await handleDeliveryResult(
    await dependencies.sendMessage(message.from, CRISIS_RESPONSE),
    message.messageId,
    dependencies
  );
  if (deliveryOutcome) return deliveryOutcome;

  // Without a claim there is no idempotency row to complete, and asking Meta to
  // redeliver would only repeat a helpline the sender already received.
  if (claim === 'uncertain') return 'completed';

  const persisted = await persistCrisisExchange(message, dependencies);
  return markMessageCompleted(
    message.messageId,
    dependencies,
    persisted ? null : 'persistence_failed'
  );
}

async function claimForMessage(
  message: WebhookMessage,
  isCrisis: boolean,
  dependencies: WebhookDependencies
): ReturnType<typeof claimIncomingMessage> {
  try {
    return await dependencies.claimIncomingMessage(message.messageId);
  } catch (error) {
    if (isCrisis) return 'uncertain';
    throw error;
  }
}

async function processMessage(
  message: WebhookMessage,
  dependencies: WebhookDependencies
): Promise<BatchMessageOutcome> {
  try {
    const isCrisis = !!message.text && isCrisisSignal(sanitizeInput(message.text));
    const claim = await claimForMessage(message, isCrisis, dependencies);
    if (claim === 'duplicate') return 'duplicate';
    if (claim === 'busy') return 'busy';
    if (isCrisis) return await handleCrisisMessage(message, claim, dependencies);
    if (claim === 'uncertain') return 'retry';

    if (!message.text) {
      const deliveryOutcome = await handleDeliveryResult(
        await dependencies.sendMessage(message.from, MEDIA_RESPONSE),
        message.messageId,
        dependencies
      );
      return deliveryOutcome || markMessageCompleted(message.messageId, dependencies);
    }

    const psicologo = await dependencies.getPsicologo(message.phoneNumberId);
    if (!psicologo) {
      const deliveryOutcome = await handleDeliveryResult(
        await dependencies.sendMessage(message.from, UNAVAILABLE_RESPONSE),
        message.messageId,
        dependencies
      );
      return deliveryOutcome || markMessageCompleted(message.messageId, dependencies);
    }

    const gateDecision = await dependencies.evaluateGate(
      message.text,
      message.from,
      psicologo,
      {
        hasSenderConsent: dependencies.hasSenderConsent,
        recordSenderConsent: dependencies.recordSenderConsent,
        consumeRateLimitSlot: dependencies.consumeRateLimitSlot,
      }
    );

    // The gate runs before getOrCreateConversacion on purpose: a sender the gate does
    // not admit must not get a conversation row, so no history exists to be written
    // even if this handler were to change later.
    //
    // The switch is exhaustive over GateDecision on purpose. The three gated outcomes
    // happen to share a shape today, but collapsing them into one `!== 'allow'` branch
    // would let a future outcome be handled by accident. Naming each one here means a
    // new outcome fails to compile instead of being silently answered.
    //
    // None of the three returns 'retry', and that is not an omission. These outcomes
    // are deliberate, reproducible answers, so a retry would make Meta redeliver the
    // same message, charging the sender a second rate-limit slot and the business a
    // second outbound message for no new information, and each attempt would re-enter
    // this gate and burn another slot.
    switch (gateDecision.outcome) {
      // Over the ceiling: send the over-limit text. No Claude, no persistence.
      case 'rate_limited':
      // Consent recorded: send the confirmation and greeting. No Claude, no persistence.
      case 'optin_confirmed':
      // Unconsented: send the deterministic answer plus the consent request. No Claude,
      // no persistence, no conversation row.
      case 'limited':
      // Consented but the rate-limit counter is unavailable: the cost bound is gone, so
      // pause the conversation rather than run the paid path with no ceiling.
      case 'degraded': {
        const gatedDeliveryOutcome = await handleDeliveryResult(
          await dependencies.sendMessage(message.from, gateDecision.response),
          message.messageId,
          dependencies
        );
        return gatedDeliveryOutcome || markMessageCompleted(message.messageId, dependencies);
      }
      // An existing consent. From here the pipeline is exactly what it was before the
      // gate existed.
      case 'allow':
        break;
    }

    const conversation = await dependencies.getOrCreateConversacion(
      psicologo.id,
      normalizePhoneNumber(message.from)
    );
    if (!conversation) {
      await dependencies.failIncomingMessage(message.messageId, 'processing_failed');
      return 'retry';
    }

    const history = dependencies.getBoundedHistory(conversation.historial);
    const botResult = await dependencies.processIncomingMessage(
      message.from,
      message.text,
      psicologo,
      history
    );

    const deliveryOutcome = await handleDeliveryResult(
      await dependencies.sendMessage(message.from, botResult.response),
      message.messageId,
      dependencies
    );
    if (deliveryOutcome) return deliveryOutcome;

    const persisted = await dependencies.appendMessagesToConversacion(
      conversation.id,
      conversation.historial,
      [
        {
          role: 'user',
          content: botResult.tipo === 'crisis' ? CRISIS_USER_MESSAGE_PLACEHOLDER : message.text,
          timestamp: new Date().toISOString(),
        },
        {
          role: 'assistant',
          content: botResult.response,
          timestamp: new Date().toISOString(),
        },
      ]
    );
    if (!persisted) {
      // Delivery succeeded. Preserve the redacted persistence failure on the completed event
      // and do not return a retry response that could send the same reply again.
      console.error('Conversation persistence failed after WhatsApp delivery');
      return markMessageCompleted(
        message.messageId,
        dependencies,
        'persistence_failed'
      );
    }

    return markMessageCompleted(message.messageId, dependencies);
  } catch {
    try {
      await dependencies.failIncomingMessage(message.messageId, 'processing_failed');
    } catch {
      console.error('Unable to preserve failed inbound message state');
    }
    return 'retry';
  }
}

export async function handleWebhook(
  request: Request,
  dependencyOverrides: Partial<WebhookDependencies> = {}
): Promise<Response> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };

  if (request.method === 'GET') return handleWebhookVerification(request);
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) return new Response('Payload Too Large', { status: 413 });

  const validSignature = await verifyMetaSignature(
    rawBody,
    request.headers.get('X-Hub-Signature-256'),
    (() => {
      try {
        return Deno.env.get('META_APP_SECRET') ?? null;
      } catch {
        return null;
      }
    })()
  );
  if (!validSignature) return new Response('Unauthorized', { status: 401 });

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  const parseResult = parseWebhookPayload(payload);
  if (!parseResult.isMessage) {
    return jsonResponse(
      { status: 'ok', statusNotification: parseResult.isStatusNotification },
      200
    );
  }

  const outcomes: BatchMessageOutcome[] = [];
  for (const message of parseResult.messages) {
    outcomes.push(await processMessage(message, dependencies));
  }

  const summary = aggregateBatchOutcomes(outcomes);
  return jsonResponse(
    {
      status: summary.status,
      completed: summary.completed,
      duplicates: summary.duplicates,
      retries: summary.retries,
      busy: summary.busy,
      deliveryUncertain: summary.deliveryUncertain,
    },
    summary.httpStatus
  );
}

if (import.meta.main) {
  Deno.serve((request) => handleWebhook(request));
}
