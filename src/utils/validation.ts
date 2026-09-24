// src/utils/validation.ts
// Input validation and sanitization

import { Psicologo } from '../types';

/**
 * Sanitize a user message to prevent injection attacks and trim length.
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/[\x00-\x1F\x7F]/g, '') // Remove control characters
    .replace(/\s+/g, ' ') // Collapse multiple whitespace
    .trim()
    .slice(0, 2000);
}

/**
 * Validate that a WhatsApp number format looks reasonable.
 * Accepts numbers with or without leading +.
 */
export function isValidWhatsAppNumber(number: string): boolean {
  if (!number || typeof number !== 'string') return false;
  const clean = number.trim();
  const regex = /^(\+)?[1-9]\d{6,14}$/;
  return regex.test(clean);
}

/**
 * Normalizes a phone number to standard E.164 format with leading +.
 */
export function normalizePhoneNumber(number: string): string {
  const clean = number.trim().replace(/[^\d+]/g, '');
  return clean.startsWith('+') ? clean : `+${clean}`;
}

/**
 * Check if a message contains clinical/medical content, emotional crisis, or personal psychological issues.
 * Returns true if the message should NEVER be handled by AI and must be forwarded.
 */
export function isClinicalQuestion(message: string): boolean {
  const clinicalKeywords = [
    'me duele', 'me siento mal', 'sintoma', 'síntoma', 'sintomas', 'síntomas',
    'ansiedad', 'depresion', 'depresión', 'medicamento', 'medicamentos',
    'medicación', 'medicacion', 'pastilla', 'pastillas', 'receta',
    'psiquiatra', 'diagnostico', 'diagnóstico', 'emergencia',
    'suicid', 'autolesion', 'autolesión', 'hacerme daño', 'morir',
    'ataque de panico', 'ataque de pánico', 'crisis de angustia',
    'angustia', 'lloro', 'no puedo mas', 'no puedo más', 'desesperad'
  ];
  const lowerMsg = message.toLowerCase();
  return clinicalKeywords.some(kw => lowerMsg.includes(kw));
}

/**
 * Check if a message is explicitly asking to schedule/book an appointment.
 */
export function isSchedulingRequest(message: string): boolean {
  const schedulingKeywords = [
    'agendar', 'reservar', 'sacar turno', 'pedir turno', 'un turno',
    'link de agenda', 'link para agendar', 'link cal', 'cal.com',
    'agendar cita', 'reservar cita', 'agendarme', 'sacar una cita', 'quiero una cita'
  ];
  const lowerMsg = message.toLowerCase();
  return schedulingKeywords.some(kw => lowerMsg.includes(kw));
}

/**
 * Check if a message is asking about administrative info.
 */
export function isAdminQuestion(message: string): boolean {
  const adminKeywords = [
    'horario', 'horarios', 'precio', 'precios', 'costo', 'costos', 'cuanto', 'cuánto',
    'valor', 'direccion', 'dirección', 'donde', 'dónde', 'ubicacion', 'ubicación',
    'modalidad', 'online', 'virtual', 'presencial', 'obra social', 'obras sociales',
    'prepaga', 'prepagas', 'pre-paga', 'sistema de salud', 'sistemas de salud'
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
