// src/bot/router.ts
// Message routing logic: determines what type of question is being asked
// and delegates to the appropriate handler

import { Psicologo, RespuestaBot, TipoConsulta } from '../types';
import { isClinicalQuestion, isSchedulingRequest, isAdminQuestion, sanitizeInput } from '../utils/validation';
import { generateResponse, quickAdminAnswer } from './claude';

/**
 * Process an incoming message from a patient and return the appropriate response.
 * This is the main routing function.
 */
export async function routeMessage(
  message: string,
  psicologo: Psicologo
): Promise<RespuestaBot> {
  const cleanMessage = sanitizeInput(message);

  if (!cleanMessage) {
    return { tipo: 'administrativa', contenido: 'No entendí tu mensaje. Escribe algo para comenzar.' };
  }

  // Rule 1: Check if it's a scheduling request FIRST (before admin/clinical)
  // Because scheduling has a specific behavior (only responds with Cal.com link)
  if (isSchedulingRequest(cleanMessage)) {
    return {
      tipo: 'programacion',
      contenido: `Para agendar tu cita con ${psicologo.nombre}, usá este link: ${psicologo.link_calcom}`,
      link_calcom: psicologo.link_calcom
    };
  }

  // Rule 2: Check if it's a clinical/personal question
  // NEVER answer clinical questions - always forward
  if (isClinicalQuestion(cleanMessage)) {
    return {
      tipo: 'clinica',
      contenido: `Esta consulta requiere atención directa con tu psicólogo. Te contactaremos a la brevedad. 🤝`
    };
  }

  // Rule 3: Try quick admin answers first (faster, no API call)
  const quickAnswer = quickAdminAnswer(cleanMessage, psicologo);
  if (quickAnswer) {
    return { tipo: 'administrativa', contenido: quickAnswer };
  }

  // Rule 4: Fall back to Claude API for nuanced admin questions
  return await generateResponse(cleanMessage, psicologo);
}

/**
 * Check if a message should trigger a scheduling link response.
 * This is used to decide if we should respond with Cal.com link.
 */
export function needsCalComLink(message: string): boolean {
  return isSchedulingRequest(message);
}
