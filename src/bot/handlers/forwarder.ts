// src/bot/handlers/forwarder.ts
// Clinical/personal question forwarder
// NEVER answers clinical questions - always forwards to the psychologist

/**
 * Determines if a message is clinical/personal and should be forwarded.
 * Returns the forward message or null if the question is not clinical.
 */
export function shouldForward(message: string): boolean {
  const clinicalKeywords = [
    'me duele', 'me duele(n)', 'siento', 'sintomas', 'síntomas',
    'ansiedad', 'depresión', 'depresion', 'medicamento', 'medicación',
    'pauta', 'terapia', 'psicólogo', 'psiquiatra', 'consulta médica',
    'tratamiento', 'hospital', 'emergencia', 'suicid', 'autolesión',
    'pauta', 'sesion', 'cita clinica', 'estoy mal', 'no puedo',
    'tengo miedo', 'miedo', 'aumento de peso', 'baje de peso',
    'insomnio', 'no puedo dormir', 'triste', 'tristeza', 'lloro',
    'angustia', 'desesperanza', 'desesperanza', 'nada tiene sentido',
    'quiero morir', 'morir', 'hacer daño', 'hacerme daño',
    'pastilla', 'píldora', 'pildora', 'sobredosis', 'sobredosis'
  ];
  const lowerMsg = message.toLowerCase();
  return clinicalKeywords.some(kw => lowerMsg.includes(kw));
}

/**
 * Generate the forward message for clinical questions.
 * This is what the patient sees when they ask a clinical question.
 */
export function getForwardMessage(psicologoNombre: string): string {
  return `Esta consulta requiere atención directa con tu psicólogo. ${psicologoNombre} te contactará a la brevedad. 🤝

No respondo preguntas clínicas, sobre medicación, síntomas ni temas personales. Para eso, comunicate directamente con tu psicólogo.`;
}

/**
 * Get a message for when the system is unsure about a question.
 */
export function getUnclearResponse(): string {
  return `No estoy seguro/a de cómo clasificar tu consulta. Si es sobre tu salud mental o bienestar personal, te recomiendo contactar a tu psicólogo directamente. Para preguntas administrativas (horarios, precio, dirección), con gusto te ayudo.`;
}
