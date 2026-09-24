// src/bot/claude.ts
// Claude API integration for Secretaria Virtual

import { Anthropic } from '@anthropic-ai/sdk';
import { Psicologo, TipoConsulta, RespuestaBot } from '../types';

const DEFAULT_MODEL = 'claude-3-5-haiku-20241022';
const MAX_TOKENS = 400;
const TEMPERATURE = 0.5;

function getSystemPrompt(psicologo: Psicologo): string {
  return `Sos la Secretaria Virtual de ${psicologo.nombre}, profesional de la psicología. Tu única función es responder preguntas administrativas sobre el consultorio de ${psicologo.nombre}.

Respondé SIEMPRE con un tono cálido, profesional y respetuoso en español rioplatense natural (usando voseo sutil: "podés", "escribime").

DATOS DEL/DE LA PROFESIONAL:
- Nombre: ${psicologo.nombre}
- Modalidad de atención: ${psicologo.modalidad}
- Dirección / Consultorio: ${psicologo.direccion}
- Honorarios / Precio de consulta: ${psicologo.precio}
- Tipo de sesión: ${psicologo.tipo_de_cita}
- Obras sociales / Prepagas aceptadas: ${psicologo.sistemas_de_salud.join(', ')}
- Link para agendar turnos: ${psicologo.link_calcom}

REGLAS ESTRICTAS:
1. Solo respondé dudas administrativas: horarios, honorarios/precios, ubicación, modalidad de atención, obras sociales y cómo reservar turno.
2. Si te consultan por temas clínicos, síntomas, diagnósticos, medicación, crisis emocionales o salud mental: NO des consejos ni diagnósticos. Respondé textualmente: "Esta consulta requiere atención directa con tu psicólogo/a. ${psicologo.nombre} te contactará a la brevedad. 🤝"
3. Si te piden un turno o cómo agendar: facilitá el link de Cal.com (${psicologo.link_calcom}).
4. Nunca inventes información que no esté en la ficha. Si no sabés un dato, decí que no contás con esa información y que lo consulte directamente con el/la profesional.`;
}

let client: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  const apiKey = (typeof Deno !== 'undefined' ? Deno.env.get('ANTHROPIC_API_KEY') : process.env.ANTHROPIC_API_KEY);
  if (!apiKey) {
    return null;
  }
  if (!client) {
    const workspaceId = (typeof Deno !== 'undefined' ? Deno.env.get('ANTHROPIC_WORKSPACE_ID') : process.env.ANTHROPIC_WORKSPACE_ID);
    client = new Anthropic({
      apiKey,
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {})
    });
  }
  return client;
}

/**
 * Generate a response to a patient's message using Claude.
 */
export async function generateResponse(
  message: string,
  psicologo: Psicologo
): Promise<RespuestaBot> {
  const claude = getAnthropicClient();
  const model = (typeof Deno !== 'undefined' ? Deno.env.get('ANTHROPIC_MODEL') : process.env.ANTHROPIC_MODEL) || DEFAULT_MODEL;

  if (!claude) {
    console.warn('ANTHROPIC_API_KEY not configured. Falling back to default message.');
    return {
      tipo: 'administrativa',
      contenido: `Gracias por tu mensaje. ${psicologo.nombre} revisará tu consulta a la brevedad. Podés consultar por horarios, honorarios, ubicación o agendar tu cita.`
    };
  }

  try {
    const response = await claude.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: getSystemPrompt(psicologo),
      messages: [{ role: 'user', content: message }]
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const lowerText = text.toLowerCase();
    let tipo: TipoConsulta = 'administrativa';

    if (lowerText.includes('cal.com') || lowerText.includes('link') || lowerText.includes('agendar') || lowerText.includes('turno')) {
      tipo = 'programacion';
    } else if (lowerText.includes('atención directa') || lowerText.includes('contactará a la brevedad')) {
      tipo = 'clinica';
    }

    return {
      tipo,
      contenido: text,
      link_calcom: tipo === 'programacion' ? psicologo.link_calcom : undefined
    };
  } catch (error) {
    console.error('Claude API error:', error);
    return {
      tipo: 'administrativa',
      contenido: `Gracias por tu consulta. En este momento estamos experimentando una demora; ${psicologo.nombre} te contactará a la brevedad.`
    };
  }
}

/**
 * Quick local answers for straightforward administrative questions (0ms latency, 0 cost).
 */
export function quickAdminAnswer(message: string, psicologo: Psicologo): string | null {
  const lowerMsg = message.toLowerCase().trim();

  if (lowerMsg.includes('precio') || lowerMsg.includes('costo') || lowerMsg.includes('cuanto') || lowerMsg.includes('cuánto') || lowerMsg.includes('valor')) {
    return `El valor de la consulta con ${psicologo.nombre} es ${psicologo.precio} (${psicologo.tipo_de_cita}).`;
  }

  if (lowerMsg.includes('direccion') || lowerMsg.includes('dirección') || lowerMsg.includes('donde') || lowerMsg.includes('dónde') || lowerMsg.includes('ubicacion') || lowerMsg.includes('ubicación')) {
    return `${psicologo.nombre} atiende en: ${psicologo.direccion}.`;
  }

  if (lowerMsg.includes('modalidad') || lowerMsg.includes('online') || lowerMsg.includes('presencial')) {
    return `${psicologo.nombre} ofrece atención en modalidad: ${psicologo.modalidad}.`;
  }

  if (lowerMsg.includes('obra social') || lowerMsg.includes('obras sociales') || lowerMsg.includes('prepaga') || lowerMsg.includes('prepagas') || lowerMsg.includes('sistema de salud')) {
    return `${psicologo.nombre} acepta los siguientes sistemas de salud: ${psicologo.sistemas_de_salud.join(', ')}.`;
  }

  return null;
}
