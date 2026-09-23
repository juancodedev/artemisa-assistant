// supabase/functions/_shared/bot.ts
// Bot orchestrator for processing incoming patient messages

import { Psicologo, RespuestaBot } from './types.ts';
import { isValidWhatsAppNumber, normalizePhoneNumber } from './validation.ts';
import { routeMessage } from './router.ts';

export interface ProcessedBotResult {
  success: boolean;
  response: string;
  tipo: string;
  link_calcom?: string;
  normalizedPatientNumber: string;
}

/**
 * Main processor for incoming patient WhatsApp messages.
 */
export async function processIncomingMessage(
  patientNumber: string,
  messageText: string,
  psicologo: Psicologo
): Promise<ProcessedBotResult> {
  const normalizedNumber = normalizePhoneNumber(patientNumber);

  if (!isValidWhatsAppNumber(normalizedNumber)) {
    return {
      success: false,
      response: 'El formato del número de WhatsApp no parece válido. Por favor contactá a tu profesional directamente.',
      tipo: 'administrativa',
      normalizedPatientNumber: normalizedNumber,
    };
  }

  const result: RespuestaBot = await routeMessage(messageText, psicologo);

  return {
    success: true,
    response: result.contenido,
    tipo: result.tipo,
    link_calcom: result.link_calcom,
    normalizedPatientNumber: normalizedNumber,
  };
}
