// src/bot/index.ts
// Main entry point for the WhatsApp bot
// Orchestrates message flow: receive → validate → route → respond → store

import { routeMessage } from './router';
import { sanitizeInput, isValidWhatsAppNumber } from '../utils/validation';
import { Psicologo } from '../types';

/**
 * Main handler for an incoming WhatsApp message.
 * This function is called by the webhook Edge Function.
 */
export async function handleIncomingMessage(
  patientNumber: string,
  messageText: string,
  psicologo: Psicologo
): Promise<{ response: string; needsCalCom?: boolean; link_calcom?: string }> {
  // Validate the patient's WhatsApp number
  if (!isValidWhatsAppNumber(patientNumber)) {
    return {
      response: 'Número de WhatsApp no válido. Contactá a tu psicólogo directamente.'
    };
  }

  // Route the message to the appropriate handler
  const result = await routeMessage(messageText, psicologo);

  const response = {
    response: result.contenido,
    needsCalCom: result.tipo === 'programacion',
    link_calcom: result.link_calcom
  };

  return response;
}

/**
 * Initialize the bot with a psychologist's data.
 * Called at startup or when a new patient conversation starts.
 */
export async function initializeBot(psicologoId: string): Promise<Psicologo | null> {
  // This would fetch from Supabase in a real implementation
  // For now, it's a placeholder for the Supabase client call
  console.log(`Initializing bot for psicologo_id: ${psicologoId}`);
  return null; // Will be replaced by actual Supabase call
}

export { Psicologo } from '../types';
export { isValidWhatsAppNumber } from '../utils/validation';
