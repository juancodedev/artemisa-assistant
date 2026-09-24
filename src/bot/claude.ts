// src/bot/claude.ts
// Claude API integration for Secretaria Virtual

import { Anthropic } from '@anthropic-ai/sdk';
import { Psicologo, TipoConsulta, RespuestaBot } from '../types';
import { isSchedulingRequest } from '../utils/validation';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 400;
const TEMPERATURE = 0.5;
const CLAUDE_TIMEOUT_MS = 15_000;
const CLAUDE_MAX_RETRIES = 1;

function getEnv(key: string): string {
  if (typeof Deno !== 'undefined' && Deno.env) return Deno.env.get(key) || '';
  return process.env[key] || '';
}

function getSystemPrompt(psicologo: Psicologo): string {
  const hours = psicologo.horarios?.trim();
  const hoursText = hours || 'No hay horarios de atención disponibles en los datos del consultorio.';

  return `Sos la Secretaria Virtual de ${psicologo.nombre}, profesional de la psicología. Tu única función es responder preguntas administrativas sobre el consultorio de ${psicologo.nombre}.

Respondé SIEMPRE con un tono cálido, profesional y respetuoso en español rioplatense natural (usando voseo sutil: "podés", "escribime").

DATOS DEL/DE LA PROFESIONAL:
- Nombre: ${psicologo.nombre}
- Modalidad de atención: ${psicologo.modalidad}
- Dirección / Consultorio: ${psicologo.direccion}
- Honorarios / Precio de consulta: ${psicologo.precio}
- Tipo de sesión: ${psicologo.tipo_de_cita}
- Obras sociales / Prepagas aceptadas: ${psicologo.sistemas_de_salud.join(', ')}
- Horarios: ${hoursText}

REGLAS ESTRICTAS:
1. Solo respondé dudas administrativas: horarios, honorarios/precios, ubicación, modalidad de atención, obras sociales y cómo reservar turno.
2. Si te consultan por temas clínicos, síntomas, diagnósticos, medicación, crisis emocionales o salud mental: NO des consejos ni diagnósticos. Respondé textualmente: "Esta consulta requiere atención directa con tu psicólogo/a. ${psicologo.nombre} te contactará a la brevedad. 🤝"
3. No incluyas ningún link de agenda en la respuesta. El link se entrega únicamente ante una solicitud explícita de agendar o reservar.
4. Nunca inventes información que no esté en la ficha. Si no sabés un dato, decí que no contás con esa información y que lo consulte directamente con la profesional.`;
}

let client: Anthropic | null = null;
let testClient: Anthropic | null | undefined;

function getAnthropicClient(): Anthropic | null {
  if (testClient !== undefined) return testClient;
  const apiKey = getEnv('ANTHROPIC_API_KEY');
  if (!apiKey) return null;
  if (!client) {
    const workspaceId = getEnv('ANTHROPIC_WORKSPACE_ID');
    client = new Anthropic({
      apiKey,
      ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {})
    });
  }
  return client;
}

export function setAnthropicClientForTests(testClientOverride: Anthropic | null): void {
  testClient = testClientOverride;
  client = null;
}

function getFallbackResponse(psicologo: Psicologo): RespuestaBot {
  return {
    tipo: 'administrativa',
    contenido: `Gracias por tu mensaje. ${psicologo.nombre} revisará tu consulta a la brevedad. Podés consultar por horarios, honorarios, ubicación o agendar tu cita.`
  };
}

function removeSchedulingLinks(text: string, profileLink: string): string {
  const escapedLink = profileLink.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(escapedLink, 'gi'), '')
    .replace(/https?:\/\/[^\s)]*cal\.com[^\s)]*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function generateResponse(
  message: string,
  psicologo: Psicologo
): Promise<RespuestaBot> {
  const claude = getAnthropicClient();
  const model = getEnv('ANTHROPIC_MODEL') || DEFAULT_MODEL;

  if (!claude) return getFallbackResponse(psicologo);

  try {
    const response = await claude.messages.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        system: getSystemPrompt(psicologo),
        messages: [{ role: 'user', content: message }]
      },
      { timeout: CLAUDE_TIMEOUT_MS, maxRetries: CLAUDE_MAX_RETRIES }
    );

    const text = response.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
      .trim();
    if (!text) return getFallbackResponse(psicologo);

    const schedulingRequested = isSchedulingRequest(message);
    const contenido = schedulingRequested ? text : removeSchedulingLinks(text, psicologo.link_calcom);
    if (!contenido) return getFallbackResponse(psicologo);

    let tipo: TipoConsulta = 'administrativa';
    if (contenido.toLowerCase().includes('atención directa') || contenido.toLowerCase().includes('contactará a la brevedad')) {
      tipo = 'clinica';
    } else if (schedulingRequested) {
      tipo = 'programacion';
    }

    return {
      tipo,
      contenido,
      link_calcom: tipo === 'programacion' ? psicologo.link_calcom : undefined
    };
  } catch {
    return {
      tipo: 'administrativa',
      contenido: `Gracias por tu consulta. En este momento estamos experimentando una demora; ${psicologo.nombre} te contactará a la brevedad.`
    };
  }
}

export function quickAdminAnswer(message: string, psicologo: Psicologo): string | null {
  const lowerMsg = message.toLowerCase().trim();

  if (lowerMsg.includes('precio') || lowerMsg.includes('costo') || lowerMsg.includes('cuanto') || lowerMsg.includes('cuánto') || lowerMsg.includes('valor')) {
    return `El valor de la consulta con ${psicologo.nombre} es ${psicologo.precio} (${psicologo.tipo_de_cita}).`;
  }

  if (lowerMsg.includes('horario') || lowerMsg.includes('horarios')) {
    return psicologo.horarios?.trim()
      ? `Los horarios de atención son: ${psicologo.horarios.trim()}.`
      : `No cuento con horarios de atención disponibles en la información del consultorio. Consultalos directamente con ${psicologo.nombre}.`;
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
