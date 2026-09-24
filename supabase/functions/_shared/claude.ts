// supabase/functions/_shared/claude.ts
// Claude API integration for Secretaria Virtual

import { Anthropic } from '@anthropic-ai/sdk';
import { Psicologo, RespuestaBot, TipoConsulta } from './types.ts';

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

let clientInstance: Anthropic | null = null;

function getAnthropicClient(): Anthropic | null {
  const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
  if (!apiKey) {
    return null;
  }
  if (!clientInstance) {
    const workspaceId = Deno.env.get('ANTHROPIC_WORKSPACE_ID');
    clientInstance = new Anthropic({
      apiKey,
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
    });
  }
  return clientInstance;
}

/**
 * Quick local answers for straightforward administrative questions (0ms latency, 0 cost).
 */
export function quickAdminAnswer(message: string, psicologo: Psicologo): string | null {
  const lower = message.toLowerCase().trim();

  // Price inquiries
  if (lower.includes('precio') || lower.includes('costo') || lower.includes('cuanto') || lower.includes('cuánto') || lower.includes('valor')) {
    return `El valor de la consulta con ${psicologo.nombre} es ${psicologo.precio} (${psicologo.tipo_de_cita}).`;
  }

  // Address inquiries
  if (lower.includes('direccion') || lower.includes('dirección') || lower.includes('donde') || lower.includes('dónde') || lower.includes('ubicacion') || lower.includes('ubicación') || lower.includes('queda')) {
    return `${psicologo.nombre} atiende en: ${psicologo.direccion}.`;
  }

  // Modality inquiries
  if (lower.includes('modalidad') || lower.includes('online') || lower.includes('presencial')) {
    return `${psicologo.nombre} atiende en modalidad: ${psicologo.modalidad}.`;
  }

  // Health insurance / prepagas inquiries
  if (lower.includes('obra social') || lower.includes('obras sociales') || lower.includes('prepaga') || lower.includes('prepagas') || lower.includes('sistema de salud')) {
    return `${psicologo.nombre} trabaja con: ${psicologo.sistemas_de_salud.join(', ')}.`;
  }

  return null;
}

/**
 * Generate an AI response using Claude Haiku.
 */
export async function generateResponse(
  message: string,
  psicologo: Psicologo
): Promise<RespuestaBot> {
  const anthropic = getAnthropicClient();
  const model = Deno.env.get('ANTHROPIC_MODEL') || DEFAULT_MODEL;

  if (!anthropic) {
    console.warn('ANTHROPIC_API_KEY is not set. Returning fallback administrative answer.');
    return {
      tipo: 'administrativa',
      contenido: `Gracias por tu mensaje. ${psicologo.nombre} revisará tu consulta a la brevedad. Podés consultar por horarios, honorarios, ubicación o agendar tu cita.`
    };
  }

  try {
    const response = await anthropic.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      system: getSystemPrompt(psicologo),
      messages: [{ role: 'user', content: message }]
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const lower = text.toLowerCase();

    let tipo: TipoConsulta = 'administrativa';
    if (lower.includes('cal.com') || lower.includes('link') || lower.includes('agendar') || lower.includes('turno')) {
      tipo = 'programacion';
    } else if (lower.includes('atención directa') || lower.includes('contactará a la brevedad')) {
      tipo = 'clinica';
    }

    return {
      tipo,
      contenido: text,
      link_calcom: tipo === 'programacion' ? psicologo.link_calcom : undefined
    };
  } catch (error) {
    console.error('Anthropic Claude API error:', error);
    return {
      tipo: 'administrativa',
      contenido: `Gracias por comunicarte. En este momento el sistema está procesando tu consulta; ${psicologo.nombre} te responderá a la brevedad.`
    };
  }
}
