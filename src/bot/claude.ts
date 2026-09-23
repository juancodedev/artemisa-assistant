// src/bot/claude.ts
// Claude API integration using Haiku 4.5 model
// Handles all AI responses for the "Secretaria Virtual"

import { Anthropic } from '@anthropic-ai/sdk';
import { Psicologo, TipoConsulta, RespuestaBot } from '../types';

const MODEL = 'claude-haiku-4-5';
const MAX_TOKENS = 500;
const TEMPERATURE = 0.7;

// System prompt defines the "secretary virtual" persona
function getSystemPrompt(psicologo: Psicologo): string {
  return `Eres la Secretaria Virtual de ${psicologo.nombre}, un/a psicólogo/a independiente. Tu única función es responder preguntas administrativas sobre ${psicologo.nombre}.

Responde SIEMPRE con un tono cálido, profesional y cercano. Usa el nombre del/a psicólogo/a cuando sea relevante.

INFORMACIÓN DEL/A PSICÓLOGO/A:
- Nombre: ${psicologo.nombre}
- Modalidad: ${psicologo.modalidad}
- Dirección: ${psicologo.direccion}
- Precio: ${psicologo.precio}
- Tipo de cita: ${psicologo.tipo_de_cita}
- Sistemas de salud aceptados: ${psicologo.sistemas_de_salud.join(', ')}
- Link de Cal.com: ${psicologo.link_calcom}

REGLAS ABSOLUTAS:
1. Solo responde preguntas administrativas: horarios, precio, dirección, modalidad, sistemas de salud, y cómo agendar.
2. Si te preguntan algo clínico, personal, sobre medicación, síntomas, o cualquier tema de salud mental: NO RESPONDAS. Di textualmente: "Esta consulta requiere atención directa con tu psicólogo. Te contactaremos a la brevedad. 🤝"
3. Si te preguntan cómo agendar o reservar una cita: responde SOLO con el link de Cal.com del psicólogo. No lo ofrezcas de forma proactiva antes de que te pregunten.
4. Nunca inventes información. Usa solo los datos proporcionados.
5. Si no sabes algo, di que no tienes esa información y sugiere contactar al psicólogo directamente.`;
}

let client: Anthropic | null = null;

function getAnthropicClient(): Anthropic {
  if (!client) {
    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY not configured');
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/**
 * Generate a response to a patient's message using Claude Haiku 4.5.
 * Returns the AI-generated text or a fallback message.
 */
export async function generateResponse(
  message: string,
  psicologo: Psicologo
): Promise<RespuestaBot> {
  const claude = getAnthropicClient();
  const systemPrompt = getSystemPrompt(psicologo);

  try {
    const response = await claude.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: systemPrompt,
      messages: [
        { role: 'user', content: message }
      ]
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';

    // Determine the type of response
    const lowerText = text.toLowerCase();
    let tipo: TipoConsulta = 'administrativa';

    if (lowerText.includes('cal.com') || lowerText.includes('link') || lowerText.includes('agendar')) {
      tipo = 'programacion';
    } else if (lowerText.includes('psicólogo') || lowerText.includes('contactar') || lowerText.includes('brevedad')) {
      tipo = 'clinica';
    }

    return {
      tipo,
      contenido: text,
      link_calcom: tipo === 'programacion' ? psicologo.link_calcom : undefined
    };
  } catch (error) {
    console.error('Claude API error:', error);
    // Fallback response if Claude fails
    return {
      tipo: 'administrativa',
      contenido: 'Gracias por tu mensaje. Tu psicólogo revisará tu consulta pronto.'
    };
  }
}

/**
 * Quick check without calling Claude - for simple administrative questions.
 * Used as a faster path when Claude is unnecessary.
 */
export function quickAdminAnswer(message: string, psicologo: Psicologo): string | null {
  const lowerMsg = message.toLowerCase().trim();

  // Check for specific administrative questions
  if (lowerMsg.includes('horario') || lowerMsg.includes('horarios')) {
    return `Los horarios de ${psicologo.nombre} son ${psicologo.modalidad}. Para agendar, escribe "cita" o "agendar".`;
  }

  if (lowerMsg.includes('precio') || lowerMsg.includes('costo') || lowerMsg.includes('cuanto')) {
    return `El valor de la consulta con ${psicologo.nombre} es ${psicologo.precio}. ${psicologo.tipo_de_cita}.`;
  }

  if (lowerMsg.includes('direccion') || lowerMsg.includes('dónde') || lowerMsg.includes('donde')) {
    return `${psicologo.nombre} atiende en: ${psicologo.direccion}`;
  }

  if (lowerMsg.includes('modalidad')) {
    return `${psicologo.nombre} ofrece atención en modalidad ${psicologo.modalidad}.`;
  }

  if (lowerMsg.includes('sistema') || lowerMsg.includes('obra social') || lowerMsg.includes('pre-paga') || lowerMsg.includes('obra_social')) {
    return `${psicologo.nombre} acepta los siguientes sistemas de salud: ${psicologo.sistemas_de_salud.join(', ')}.`;
  }

  return null; // Return null to indicate Claude should be called
}
