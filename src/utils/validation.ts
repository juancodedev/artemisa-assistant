// src/utils/validation.ts
// Input validation and sanitization

import { Psicologo } from '../types';

/**
 * Sanitize a user message to prevent injection attacks.
 * Strips potentially dangerous characters and limits length.
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  // Strip HTML, control characters, and excessive whitespace
  return input
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .replace(/\s+/g, ' ') // Collapse multiple whitespace
    .trim()
    .slice(0, 2000); // Limit length
}

/**
 * Validate that a WhatsApp number format looks reasonable.
 * Basic validation - the actual format check is done by WhatsApp API.
 */
export function isValidWhatsAppNumber(number: string): boolean {
  // E.164 format: +[country code][number], e.g., +5491123456789
  const e164Regex = /^\+[1-9]\d{1,14}$/;
  return e164Regex.test(number);
}

/**
 * Check if a message contains clinical/personal content.
 * Returns true if the message seems to be a medical/clinical question.
 */
export function isClinicalQuestion(message: string): boolean {
  const clinicalKeywords = [
    'me duele', 'me duele(n)', 'siento', 'sintomas', 'síntomas',
    'ansiedad', 'depresión', 'depresion', 'medicamento', 'medicación',
    'pauta', 'terapia', 'psicólogo', 'psiquiatra', 'consulta médica',
    'tratamiento', 'hospital', 'emergencia', 'suicid', 'autolesión',
    'pauta', 'sesion', 'cita clinica'
  ];
  const lowerMsg = message.toLowerCase();
  return clinicalKeywords.some(kw => lowerMsg.includes(kw));
}

/**
 * Check if a message is asking to schedule/reserve.
 */
export function isSchedulingRequest(message: string): boolean {
  const schedulingKeywords = [
    'agendar', 'reservar', 'cita', 'horario', 'programar',
    'cuando puedo', 'cuando est', 'disponibilidad', 'cal.com'
  ];
  const lowerMsg = message.toLowerCase();
  return schedulingKeywords.some(kw => lowerMsg.includes(kw));
}

/**
 * Check if a message is asking about administrative info.
 */
export function isAdminQuestion(message: string): boolean {
  const adminKeywords = [
    'horarios', 'precio', 'costo', 'cuanto', 'direccion', 'dónde',
    'donde', 'modalidad', 'sistemas de salud', 'obras sociales',
    'pre-paga', 'cal.com', 'calendario', 'link', 'ubicacion',
    'atencion', 'contacto'
  ];
  const lowerMsg = message.toLowerCase();
  return adminKeywords.some(kw => lowerMsg.includes(kw));
}

/**
 * Validate that a Psicologo object has all required fields.
 */
export function validatePsicologo(psicologo: Partial<Psicologo>): boolean {
  const required: (keyof Psicologo)[] = [
    'nombre', 'numero_whatsapp', 'modalidad', 'direccion',
    'precio', 'tipo_de_cita', 'sistemas_de_salud', 'link_calcom'
  ];
  return required.every(field => psicologo[field] !== undefined && psicologo[field] !== null && psicologo[field] !== '');
}
