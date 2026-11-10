// supabase/functions/_shared/validation.ts
// Input validation and sanitization for patient messages

import { Psicologo } from './types.ts';

/**
 * Sanitize user input to strip control characters and limit length.
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
 * Validate WhatsApp phone number (accepts with or without leading +).
 */
export function isValidWhatsAppNumber(number: string): boolean {
  if (!number || typeof number !== 'string') return false;
  const clean = number.trim();
  // Accepts +[country][number] or pure digits (e.g. 5491123456789)
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

// Matched against lowercased text with accents removed, so patterns are written
// without accents. Leaning towards a match is deliberate: a false positive costs the
// patient's request, a false negative leaves a person in crisis without the helpline.
// So the two phrases that are also everyday idioms match by default, and only their
// known idiomatic continuations are excluded: "me mato estudiando", "terminar con todo
// el papeleo" (a chore, not a determiner, is what makes it everyday speech).
// "Esta noche me mato", "terminar con todo esto" and "acabar con todo mi dolor" still
// match, and so do continuations with a preposition, as in "me mato con las pastillas".
const CRISIS_PATTERNS: readonly RegExp[] = [
  /suicid/,
  /\bmatarme\b/,
  /\bme (?:quiero|voy a|gustaria|quisiera|pienso) matar\b/,
  /\bme mato\b(?!\s+(?:estudiando|trabajando|haciendo|corriendo|entrenando|de (?:la )?risa)\b)/,
  /\bquitarme la vida\b/,
  /\bme (?:quiero|voy a|pienso|quisiera) quitar la vida\b/,
  /\b(?:acabar|terminar) con mi vida\b/,
  // Only administrative chores are excluded, so "con todo mi dolor" still matches.
  /\b(?:acabar|terminar) con todo\b(?!\s+(?:(?:el|la|los|las|un|una|mi|mis|tu|tus|su|sus|del|este|esta|ese|esa)\s+)?(?:papeleo|tramites?|trabajo|tareas?|pendientes?|informes?|proyectos?|reembolsos?|pagos?|documentos?|formularios?|examen(?:es)?|estudios?)\b)/,
  /\bno (?:quiero|deseo) (?:seguir )?(?:vivir|viviendo|estar viv[oa])\b/,
  /\bno vale la pena (?:seguir )?(?:vivir|viviendo)\b/,
  /\bno tiene sentido (?:seguir )?(?:vivir|viviendo)\b/,
  /\bmi vida no tiene sentido\b/,
  /\b(?:quiero|quisiera|deseo|prefiero|ganas de) morir(?:me)?\b/,
  /\bojala me (?:muriera|muera)\b/,
  /\bmejor muert[oa]\b/,
  /\bhacerme dano\b/,
  /\bme (?:quiero|voy a) hacer dano\b/,
  /\blastimarme\b/,
  /\bme (?:quiero|voy a) lastimar\b/,
  /autolesion/,
  /\b(?:cortarme|me (?:voy a |quiero )?cort(?:ar|o|e)) (?:las venas|los brazos|las munecas)\b/,
  /\bahorcarme\b/,
  /\b(?:tirarme|lanzarme|me (?:voy a |quiero )(?:tirar|lanzar)) (?:al metro|a las vias|de un|del|desde|por la ventana|por el balcon)\b/,
  /\btomar(?:me)? todas las pastillas\b/,
  /\bsobredosis\b/,
];

/**
 * Check if a message contains a suicide or self-harm signal.
 */
export function isCrisisSignal(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  return CRISIS_PATTERNS.some((pattern) => pattern.test(normalized));
}

// Clinical keywords, compared against the message lowercased and without accents, so
// each one is written once, without accents. Detection is a heuristic: it lowers what
// reaches Claude and storage, and a message it misses still goes through as written.
//
// "panico" is handled apart, below: "me da pánico hablar por teléfono" is an
// administrative question, while "tengo mucho pánico" discloses a symptom.
const CLINICAL_KEYWORDS: readonly string[] = [
  // Symptoms and states.
  'me duele', 'me siento mal', 'sintoma', 'ansiedad', 'depresion', 'deprimid',
  'angustia', 'lloro', 'no puedo mas', 'desesperad', 'no puedo dormir', 'insomnio',
  // Treatment.
  'medicamento', 'medicacion', 'pastilla', 'receta', 'psiquiatra', 'diagnostico',
  'antidepresiv', 'ansiolitic',
  // Psychiatric medication commonly prescribed in Chile.
  'sertralina', 'fluoxetina', 'escitalopram', 'paroxetina', 'venlafaxina',
  'clonazepam', 'alprazolam', 'lorazepam', 'zolpidem', 'quetiapina',
  // Risk words; crisis phrasing proper is caught first by isCrisisSignal.
  'emergencia', 'suicid', 'autolesion', 'hacerme dano', 'morir',
];

/**
 * Check if a message contains clinical/medical symptoms or psychological issues.
 * Never answers clinical questions directly - always delegates to the professional.
 */
export function isClinicalQuestion(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (CLINICAL_KEYWORDS.some((keyword) => normalized.includes(keyword))) return true;
  // Any mention of panic counts, except the everyday "(me) da pánico". The everyday
  // phrases are removed first, so one of them cannot hide another mention.
  return /panico/.test(normalized.replace(/\bdan? (?:(?:un poco de|algo de|mucho) )?panico\b/g, ''));
}

export const CRISIS_TEXT_PLACEHOLDER = '[mensaje de crisis omitido]';
export const CLINICAL_TEXT_PLACEHOLDER = '[mensaje clínico omitido]';

/**
 * Replace a patient message that reveals health information with a fixed marker, so it
 * is neither stored nor sent to Claude. Detection is the same keyword heuristic the
 * router uses: it lowers exposure, but a message it misses still goes through as is.
 */
export function redactSensitiveText(text: string): string {
  if (isCrisisSignal(text)) return CRISIS_TEXT_PLACEHOLDER;
  if (isClinicalQuestion(text)) return CLINICAL_TEXT_PLACEHOLDER;
  return text;
}

/**
 * Check if a message explicitly requests booking or scheduling an appointment.
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
 * Check if a message is an administrative inquiry.
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
 * Validate that a Psicologo object contains required profile information.
 */
export function validatePsicologo(psicologo: Partial<Psicologo>): boolean {
  const required: (keyof Psicologo)[] = [
    'nombre', 'numero_whatsapp', 'modalidad', 'direccion',
    'precio', 'tipo_de_cita', 'sistemas_de_salud', 'link_calcom'
  ];
  return required.every(field => psicologo[field] !== undefined && psicologo[field] !== null && psicologo[field] !== '');
}
