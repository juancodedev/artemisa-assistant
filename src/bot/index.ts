// src/bot/index.ts
// Main entry point for the WhatsApp bot
// Orchestrates message flow: receive → validate → route → respond → store

import { routeMessage } from './router';
import { sanitizeInput, isValidWhatsAppNumber, normalizePhoneNumber } from '../utils/validation';
import { Psicologo, RespuestaBot } from '../types';
import { supabase } from '../services/supabase';

/**
 * Main handler for an incoming WhatsApp message.
 */
export async function handleIncomingMessage(
  patientNumber: string,
  messageText: string,
  psicologo: Psicologo
): Promise<{ response: string; needsCalCom?: boolean; link_calcom?: string }> {
  const normalized = normalizePhoneNumber(patientNumber);

  if (!isValidWhatsAppNumber(normalized)) {
    return {
      response: 'Número de WhatsApp no válido. Contactá a tu psicólogo directamente.',
    };
  }

  const result: RespuestaBot = await routeMessage(messageText, psicologo);

  return {
    response: result.contenido,
    needsCalCom: result.tipo === 'programacion',
    link_calcom: result.link_calcom,
  };
}

/**
 * Initialize the bot with a psychologist's data from Supabase.
 */
export async function initializeBot(psicologoId?: string): Promise<Psicologo | null> {
  try {
    if (psicologoId) {
      const psicologos = await supabase.getPsicologos();
      return psicologos.find((p: any) => p.id === psicologoId) || null;
    }
    const psicologos = await supabase.getPsicologos();
    return psicologos.length === 1 ? (psicologos[0] as Psicologo) : null;
  } catch (error) {
    console.error('Error in initializeBot:', error);
    return null;
  }
}

export { Psicologo } from '../types';
export { isValidWhatsAppNumber, normalizePhoneNumber } from '../utils/validation';
