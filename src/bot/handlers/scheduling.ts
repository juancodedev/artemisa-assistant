// src/bot/handlers/scheduling.ts
// Scheduling handler - provides Cal.com link when patient explicitly asks to schedule

import { Psicologo } from '../../types';

/**
 * Handle scheduling requests.
 * Returns the Cal.com link ONLY when explicitly asked.
 * Never offers proactively.
 */
export function handleScheduling(message: string, psicologo: Psicologo): string | null {
  const lowerMsg = message.toLowerCase().trim();

  const schedulingKeywords = [
    'agendar', 'reservar', 'cita', 'horario', 'programar',
    'cuando puedo', 'cuando est', 'disponibilidad', 'cal.com',
    'calendario', 'link de cita', 'link'
  ];

  const wantsToSchedule = schedulingKeywords.some(kw => lowerMsg.includes(kw));

  if (wantsToSchedule) {
    return `Para agendar tu cita con ${psicologo.nombre}, usá este link: ${psicologo.link_calcom}`;
  }

  return null;
}

/**
 * Validate that a scheduling request is legitimate (not spam/fake).
 */
export function isValidSchedulingRequest(message: string): boolean {
  // Check for reasonable scheduling indicators
  const hasSchedulingKeyword = message.toLowerCase().includes('agendar');
  const hasTimeReference = /\b(hora|hs|pm|am|tarde|mañana|martes|miércoles|miercoles|jueves|viernes|lunes)\b/i.test(message);
  
  return hasSchedulingKeyword || hasTimeReference;
}
