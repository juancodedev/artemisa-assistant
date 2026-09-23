// supabase/functions/_shared/router.ts
// Decision router for Artemisa Assistant

import { Psicologo, RespuestaBot } from './types.ts';
import { sanitizeInput, isClinicalQuestion, isSchedulingRequest } from './validation.ts';
import { generateResponse, quickAdminAnswer } from './claude.ts';

/**
 * Route an incoming message from a patient to the appropriate response handler.
 */
export async function routeMessage(
  message: string,
  psicologo: Psicologo
): Promise<RespuestaBot> {
  const cleanMessage = sanitizeInput(message);

  if (!cleanMessage) {
    return {
      tipo: 'administrativa',
      contenido: `¡Hola! Soy la Secretaria Virtual de ${psicologo.nombre}. ¿En qué puedo ayudarte hoy? Podés consultarme por precios, horarios, ubicación o cómo agendar una cita.`,
    };
  }

  // 1. Explicit scheduling request -> Deliver Cal.com link
  if (isSchedulingRequest(cleanMessage)) {
    return {
      tipo: 'programacion',
      contenido: `Para agendar tu cita con ${psicologo.nombre}, podés elegir el día y horario que mejor te quede acá: ${psicologo.link_calcom}`,
      link_calcom: psicologo.link_calcom,
    };
  }

  // 2. Clinical question / Medical symptom / Emergency -> Never answer clinically, forward to professional
  if (isClinicalQuestion(cleanMessage)) {
    return {
      tipo: 'clinica',
      contenido: `Esta consulta requiere atención directa con tu psicólogo/a. ${psicologo.nombre} te contactará a la brevedad. 🤝`,
    };
  }

  // 3. Fast-path administrative answer (0ms latency)
  const quickAnswer = quickAdminAnswer(cleanMessage, psicologo);
  if (quickAnswer) {
    return {
      tipo: 'administrativa',
      contenido: quickAnswer,
    };
  }

  // 4. Fallback to Claude AI for contextual, nuanced administrative questions
  return await generateResponse(cleanMessage, psicologo);
}
