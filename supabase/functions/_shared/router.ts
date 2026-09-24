// supabase/functions/_shared/router.ts
// Decision router for Artemisa Assistant.

import { MensajeHistoria, Psicologo, RespuestaBot } from './types.ts';
import { sanitizeInput, isClinicalQuestion, isCrisisSignal, isSchedulingRequest } from './validation.ts';
import { generateResponse, quickAdminAnswer } from './claude.ts';

export const CRISIS_RESPONSE =
  'Tu bienestar importa. Si estás pasando por una crisis, llamá gratis y confidencialmente a la Línea de Prevención del Suicidio al *4141, disponible las 24 horas. También podés llamar a Salud Responde al 600 360 7777 y seleccionar la opción 2. Esta conversación no reemplaza la atención profesional.';

/**
 * Route an incoming message from a patient to the appropriate response handler.
 */
export async function routeMessage(
  message: string,
  psicologo: Psicologo,
  history: MensajeHistoria[] = []
): Promise<RespuestaBot> {
  const cleanMessage = sanitizeInput(message);

  if (!cleanMessage) {
    return {
      tipo: 'administrativa',
      contenido: `¡Hola! Soy la Secretaria Virtual de ${psicologo.nombre}. ¿En qué puedo ayudarte hoy? Podés consultarme por precios, horarios, ubicación o cómo agendar una cita.`,
    };
  }

  // Crisis safety takes priority over all other routing, including scheduling and Claude.
  if (isCrisisSignal(cleanMessage)) {
    return {
      tipo: 'crisis',
      contenido: CRISIS_RESPONSE,
    };
  }

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

  return await generateResponse(cleanMessage, psicologo, history);
}
