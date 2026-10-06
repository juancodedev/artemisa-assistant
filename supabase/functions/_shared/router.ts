// supabase/functions/_shared/router.ts
// Decision router for Artemisa Assistant.

import { MensajeHistoria, Psicologo, RespuestaBot } from './types.ts';
import { sanitizeInput, isClinicalQuestion, isCrisisSignal, isSchedulingRequest } from './validation.ts';
import { generateResponse, quickAdminAnswer } from './claude.ts';

export const CRISIS_RESPONSE =
  'Tu bienestar importa. Si estás pasando por una crisis, llamá gratis y confidencialmente a la Línea de Prevención del Suicidio al *4141, disponible las 24 horas. También podés llamar a Salud Responde al 600 360 7777 y seleccionar la opción 2. Esta conversación no reemplaza la atención profesional.';

/**
 * Greeting served for an empty message, and the introduction a sender receives the
 * first time they write. Extracted so the opt-in gate can greet a sender without
 * duplicating this copy, which must stay in one place to stay in sync.
 */
export function greetingResponse(psicologo: Psicologo): RespuestaBot {
  return {
    tipo: 'administrativa',
    contenido: `¡Hola! Soy la Secretaria Virtual de ${psicologo.nombre}. ¿En qué puedo ayudarte hoy? Podés consultarme por precios, horarios, ubicación o cómo agendar una cita.`,
  };
}

/**
 * Deterministic routing: everything this bot can answer locally, with no Claude call.
 * Returns null when nothing matched, which is the caller's signal that only Claude
 * could answer.
 *
 * This is ALSO the path the opt-in gate in gate.ts serves to a sender who has not
 * consented, which is precisely why it must stay free of any Claude call: it is the
 * only way a stranger is answered before consent, and adding a generated answer here
 * would put an unconsented party straight back on the paid path that the gate exists
 * to keep them off. The same constraint forbids reading conversation history here, so
 * the function takes no history argument.
 *
 * The message is expected to be already sanitized; the caller runs sanitizeInput.
 * The empty message is deliberately NOT handled here. It has no deterministic answer,
 * so this returns null for it and the caller decides what to serve, which keeps the
 * short-circuit for an empty message owned by exactly one place in the routing order.
 *
 * Order matters and matches routeMessage exactly: scheduling before clinical before
 * quick admin.
 */
export function routeDeterministicMessage(
  cleanMessage: string,
  psicologo: Psicologo
): RespuestaBot | null {
  // Explicit scheduling requests are handled locally so no generated answer can leak the link.
  if (isSchedulingRequest(cleanMessage)) {
    return {
      tipo: 'programacion',
      contenido: `Para agendar tu cita con ${psicologo.nombre}, podés elegir el día y horario que mejor te quede acá: ${psicologo.link_calcom}`,
      link_calcom: psicologo.link_calcom,
    };
  }

  // Clinical questions are never answered or forwarded to an invented channel.
  if (isClinicalQuestion(cleanMessage)) {
    return {
      tipo: 'clinica',
      contenido: `Esta consulta requiere atención directa con tu psicólogo/a. ${psicologo.nombre} te contactará a la brevedad.`,
    };
  }

  const quickAnswer = quickAdminAnswer(cleanMessage, psicologo);
  if (quickAnswer) {
    return {
      tipo: 'administrativa',
      contenido: quickAnswer,
    };
  }

  return null;
}

/**
 * Route an incoming message from a patient to the appropriate response handler.
 *
 * The precedence below is the routing contract and must not change: empty message,
 * then crisis, then scheduling, then clinical, then quick admin, then Claude. Crisis
 * is evaluated BEFORE routeDeterministicMessage, so a message that is both a crisis
 * signal and a scheduling or clinical request still receives CRISIS_RESPONSE.
 */
export async function routeMessage(
  message: string,
  psicologo: Psicologo,
  history: MensajeHistoria[] = []
): Promise<RespuestaBot> {
  const cleanMessage = sanitizeInput(message);

  if (!cleanMessage) {
    return greetingResponse(psicologo);
  }

  // Crisis safety takes priority over all other routing, including scheduling and Claude.
  if (isCrisisSignal(cleanMessage)) {
    return {
      tipo: 'crisis',
      contenido: CRISIS_RESPONSE,
    };
  }

  const deterministicAnswer = routeDeterministicMessage(cleanMessage, psicologo);
  if (deterministicAnswer) return deterministicAnswer;

  return await generateResponse(cleanMessage, psicologo, history);
}
