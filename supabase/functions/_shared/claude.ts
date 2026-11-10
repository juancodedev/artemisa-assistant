// supabase/functions/_shared/claude.ts
// Claude API integration for Secretaria Virtual.

import { Anthropic } from '@anthropic-ai/sdk';
import { MensajeHistoria, Psicologo, RespuestaBot, TipoConsulta } from './types.ts';
import { isSchedulingRequest, redactSensitiveText } from './validation.ts';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 400;
const TEMPERATURE = 0.5;
const CLAUDE_TIMEOUT_MS = 15_000;
const CLAUDE_MAX_RETRIES = 1;

function getEnv(name: string): string {
  try {
    return Deno.env.get(name) || '';
  } catch {
    return '';
  }
}

/**
 * The only answer to a clinical question, from the router and from Claude alike.
 * Nobody monitors this channel, so it must not promise that the professional will
 * follow up: it points the patient to a channel that reaches a person.
 */
// The phrase that identifies the referral in Claude's reply. The response is built from
// it, so changing the wording cannot silently break isClinicalRefusal.
const CLINICAL_REFERRAL_MARKER = 'atención directa';

export const CLINICAL_REFERRAL_RESPONSE =
  `Esta consulta requiere ${CLINICAL_REFERRAL_MARKER} con tu psicólogo/a y por este medio no puedo derivarla. Escríbele por tu canal habitual o agenda una cita.`;

function getSystemPrompt(psicologo: Psicologo): string {
  const hours = psicologo.horarios?.trim();
  const hoursText = hours || 'No hay horarios de atención disponibles en los datos del consultorio.';

  return `Eres la Secretaria Virtual de ${psicologo.nombre}, profesional de la psicología. Tu única función es responder preguntas administrativas sobre el consultorio de ${psicologo.nombre}.

Responde siempre con un tono cálido, profesional y respetuoso, en español neutro y tuteando, sin voseo.

DATOS DEL/DE LA PROFESIONAL:
- Nombre: ${psicologo.nombre}
- Modalidad de atención: ${psicologo.modalidad}
- Dirección / Consultorio: ${psicologo.direccion}
- Honorarios / Precio de consulta: ${psicologo.precio}
- Tipo de sesión: ${psicologo.tipo_de_cita}
- Obras sociales / Prepagas aceptadas: ${psicologo.sistemas_de_salud.join(', ')}
- Horarios: ${hoursText}

REGLAS ESTRICTAS:
1. Solo responde dudas administrativas: horarios, honorarios/precios, ubicación, modalidad de atención, sistemas de salud y cómo reservar una cita.
2. Si te consultan por temas clínicos, síntomas, diagnósticos, medicación, crisis emocionales o salud mental: NO des consejos ni diagnósticos. Responde textualmente: "${CLINICAL_REFERRAL_RESPONSE}"
3. No incluyas ningún link de agenda en la respuesta. El link se entrega únicamente cuando el paciente escribe una solicitud explícita de agendar o reservar.
4. Nunca inventes información que no esté en la ficha. Si no sabes un dato, di que no cuentas con esa información y que la consulte directamente con la profesional.
5. Nunca prometas que la profesional se pondrá en contacto: nadie lee este canal.`;
}

let clientInstance: Anthropic | null = null;
let testClient: Anthropic | null | undefined;

function getAnthropicClient(): Anthropic | null {
  if (testClient !== undefined) return testClient;

  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!apiKey) return null;

  if (!clientInstance) {
    const workspaceId = getEnv('ANTHROPIC_WORKSPACE_ID');
    clientInstance = new Anthropic({
      apiKey,
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}),
    });
  }
  return clientInstance;
}

export function setAnthropicClientForTests(client: Anthropic | null): void {
  testClient = client;
  clientInstance = null;
}

function getFallbackResponse(psicologo: Psicologo): RespuestaBot {
  return {
    tipo: 'administrativa',
    contenido: `Gracias por tu mensaje. Por ahora no pude procesar tu consulta. Puedes preguntarme por horarios, honorarios, ubicación o cómo agendar una cita; para otros temas, comunícate directamente con ${psicologo.nombre}.`,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeSchedulingLinks(text: string, profileLink: string): string {
  let sanitized = text;
  if (profileLink) {
    sanitized = sanitized.replace(new RegExp(escapeRegExp(profileLink), 'gi'), '');
  }
  sanitized = sanitized.replace(/(?:https?:\/\/)?(?:www\.)?cal\.com\/[^\s)]*/gi, '');
  return sanitized.replace(/\s{2,}/g, ' ').trim();
}

function isClinicalRefusal(text: string): boolean {
  return text.toLowerCase().includes(CLINICAL_REFERRAL_MARKER);
}

function toClaudeMessages(
  history: MensajeHistoria[],
  currentMessage: string
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return [
    // Redacted here as well as on write: history stored before redaction existed may
    // still hold raw clinical text, and this is the only path to Claude.
    ...history.map((item) => ({
      role: item.role,
      content: item.role === 'user' ? redactSensitiveText(item.content) : item.content,
    })),
    { role: 'user' as const, content: currentMessage },
  ];
}

/**
 * Quick local answers for straightforward administrative questions (0ms latency, 0 cost).
 */
export function quickAdminAnswer(message: string, psicologo: Psicologo): string | null {
  const lower = message.toLowerCase().trim();

  if (
    lower.includes('precio') ||
    lower.includes('costo') ||
    lower.includes('cuanto') ||
    lower.includes('cuánto') ||
    lower.includes('valor')
  ) {
    return `El valor de la consulta con ${psicologo.nombre} es ${psicologo.precio} (${psicologo.tipo_de_cita}).`;
  }

  if (
    lower.includes('horario') ||
    lower.includes('horarios') ||
    lower.includes('disponibilidad')
  ) {
    return psicologo.horarios?.trim()
      ? `Los horarios de atención son: ${psicologo.horarios.trim()}.`
      : `No cuento con horarios de atención disponibles en la información del consultorio. Consúltalos directamente con ${psicologo.nombre}.`;
  }

  if (
    lower.includes('direccion') ||
    lower.includes('dirección') ||
    lower.includes('donde') ||
    lower.includes('dónde') ||
    lower.includes('ubicacion') ||
    lower.includes('ubicación') ||
    lower.includes('queda')
  ) {
    return `${psicologo.nombre} atiende en: ${psicologo.direccion}.`;
  }

  if (
    lower.includes('modalidad') ||
    lower.includes('online') ||
    lower.includes('presencial')
  ) {
    return `${psicologo.nombre} atiende en modalidad: ${psicologo.modalidad}.`;
  }

  if (
    lower.includes('obra social') ||
    lower.includes('obras sociales') ||
    lower.includes('prepaga') ||
    lower.includes('prepagas') ||
    lower.includes('sistema de salud')
  ) {
    return `${psicologo.nombre} trabaja con: ${psicologo.sistemas_de_salud.join(', ')}.`;
  }

  return null;
}

/**
 * Generate an AI response using Claude Haiku.
 */
export async function generateResponse(
  message: string,
  psicologo: Psicologo,
  history: MensajeHistoria[] = []
): Promise<RespuestaBot> {
  const anthropic = getAnthropicClient();
  const model = getEnv('ANTHROPIC_MODEL') || DEFAULT_MODEL;

  if (!anthropic) {
    console.warn('Claude is not configured; returning a safe fallback');
    return getFallbackResponse(psicologo);
  }

  try {
    const response = await anthropic.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: getSystemPrompt(psicologo),
        messages: toClaudeMessages(history, message),
      },
      {
        timeout: CLAUDE_TIMEOUT_MS,
        maxRetries: CLAUDE_MAX_RETRIES,
      }
    );

    const text = response.content
      .filter((block): block is { type: 'text'; text: string } => {
        return block.type === 'text' && typeof block.text === 'string';
      })
      .map((block) => block.text)
      .join('')
      .trim();

    if (!text) return getFallbackResponse(psicologo);

    const schedulingRequested = isSchedulingRequest(message);
    const content = schedulingRequested
      ? text
      : removeSchedulingLinks(text, psicologo.link_calcom);
    if (!content) return getFallbackResponse(psicologo);

    let tipo: TipoConsulta = 'administrativa';
    if (isClinicalRefusal(content)) {
      tipo = 'clinica';
    } else if (schedulingRequested) {
      tipo = 'programacion';
    }

    return {
      tipo,
      contenido: content,
      link_calcom: tipo === 'programacion' ? psicologo.link_calcom : undefined,
    };
  } catch {
    console.error('Claude API request failed');
    return {
      tipo: 'administrativa',
      contenido: `Gracias por comunicarte. En este momento no pude procesar tu consulta. Por favor, intenta de nuevo más tarde o comunícate directamente con ${psicologo.nombre}.`,
    };
  }
}
