// src/bot/router.ts
// Message routing logic: determines what type of question is being asked
// and delegates to the appropriate handler

import { Psicologo, RespuestaBot } from '../types';
import { isClinicalQuestion, isSchedulingRequest, sanitizeInput } from '../utils/validation';
import { generateResponse, quickAdminAnswer } from './claude';

/**
 * Process an incoming message from a patient and return the appropriate response.
 */
export async function routeMessage(
  message: string,
  psicologo: Psicologo
): Promise<RespuestaBot> {
  const cleanMessage = sanitizeInput(message);

  if (!cleanMessage) {
    return {
      tipo: 'administrativa',
      contenido: `¡Hola! Soy la Secretaria Virtual de ${psicologo.nombre}. ¿En qué puedo ayudarte hoy? Podés consultarme por precios, horarios, ubicación o cómo agendar tu cita.`,
    };
  }

  // Rule 1: Check if it's an explicit scheduling request FIRST
  if (isSchedulingRequest(cleanMessage)) {
    return {
      tipo: 'programacion',
      contenido: `Para agendar tu cita con ${psicologo.nombre}, podés elegir el día y horario que mejor te quede acá: ${psicologo.link_calcom}`,
      link_calcom: psicologo.link_calcom,
    };
  }

  // Rule 2: Check if it's a clinical/personal question
  // NEVER answer clinical questions - always forward
  if (isClinicalQuestion(cleanMessage)) {
    return {
      tipo: 'clinica',
      contenido: `Esta consulta requiere atención directa con tu psicólogo/a. ${psicologo.nombre} te contactará a la brevedad. 🤝`,
    };
  }

  // Rule 3: Try quick admin answers first (0ms, no API cost)
  const quickAnswer = quickAdminAnswer(cleanMessage, psicologo);
  if (quickAnswer) {
    return { tipo: 'administrativa', contenido: quickAnswer };
  }

  // Rule 4: Fall back to Claude API for nuanced admin questions
  return await generateResponse(cleanMessage, psicologo);
}

/**
 * Check if a message should trigger a scheduling link response.
 */
export function needsCalComLink(message: string): boolean {
  return isSchedulingRequest(message);
}
