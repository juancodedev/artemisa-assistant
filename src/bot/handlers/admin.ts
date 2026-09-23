// src/bot/handlers/admin.ts
// Administrative question handlers
// These handle questions about hours, modality, price, address, health systems

import { Psicologo } from '../../types';

/**
 * Handle administrative questions about the psychologist's profile.
 * Returns a formatted response string or null if not applicable.
 */
export function handleAdminQuestion(message: string, psicologo: Psicologo): string | null {
  const lowerMsg = message.toLowerCase().trim();

  if (lowerMsg.includes('horario') || lowerMsg.includes('horarios')) {
    return `Los horarios de ${psicologo.nombre} son en modalidad ${psicologo.modalidad}. Para agendar una cita, escribí "agendar" o "cita".`;
  }

  if (lowerMsg.includes('precio') || lowerMsg.includes('costo') || lowerMsg.includes('cuanto')) {
    return `El valor de la consulta con ${psicologo.nombre} es ${psicologo.precio}. ${psicologo.tipo_de_cita}.`;
  }

  if (lowerMsg.includes('direccion') || lowerMsg.includes('dónde') || lowerMsg.includes('donde') || lowerMsg.includes('ubicacion')) {
    return `${psicologo.nombre} atiende en: ${psicologo.direccion}`;
  }

  if (lowerMsg.includes('modalidad')) {
    return `${psicologo.nombre} ofrece atención en modalidad ${psicologo.modalidad}. La consulta es presencial y virtual.`;
  }

  if (lowerMsg.includes('sistema') || lowerMsg.includes('obra social') || lowerMsg.includes('pre-paga') || lowerMsg.includes('obra_social')) {
    return `${psicologo.nombre} acepta los siguientes sistemas de salud: ${psicologo.sistemas_de_salud.join(', ')}.`;
  }

  return null;
}

/**
 * Build a general info response for the psychologist profile.
 */
export function buildGeneralInfo(psicologo: Psicologo): string {
  return `Bienvenido/a! Soy la Secretaria Virtual de ${psicologo.nombre}. 

Aquí está la información disponible:
- **Modalidad**: ${psicologo.modalidad}
- **Dirección**: ${psicologo.direccion}
- **Precio**: ${psicologo.precio}
- **Tipo de cita**: ${psicologo.tipo_de_cita}
- **Sistemas de salud**: ${psicologo.sistemas_de_salud.join(', ')}

Escribí "horarios", "precio", "dirección", "modalidad", "sistemas de salud" o "agendar" para más info.`;
}
