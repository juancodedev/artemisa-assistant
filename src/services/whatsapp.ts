// src/services/whatsapp.ts
// WhatsApp Business Cloud API client

const DEFAULT_GRAPH_API_VERSION = 'v25.0';
const DEFAULT_META_TIMEOUT_MS = 10_000;
const MAX_META_TIMEOUT_MS = 30_000;
const GRAPH_API_VERSION_PATTERN = /^v\d{1,3}\.\d{1,3}$/;

function getEnv(key: string): string {
  if (typeof Deno !== 'undefined' && Deno.env) {
    return Deno.env.get(key) || '';
  }
  return process.env[key] || '';
}

/**
 * Send a text message to a WhatsApp user via Meta Cloud API.
 */
export async function sendMessage(
  to: string,
  text: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const phoneNumberId = getEnv('META_PHONE_NUMBER_ID');
  const accessToken = getEnv('META_ACCESS_TOKEN');

  if (!phoneNumberId || !accessToken) {
    return { success: false, error: 'WhatsApp credentials not configured (missing META_PHONE_NUMBER_ID or META_ACCESS_TOKEN)' };
  }

  const configuredVersion = getEnv('META_GRAPH_API_VERSION');
  const graphVersion = configuredVersion
    ? GRAPH_API_VERSION_PATTERN.test(configuredVersion) ? configuredVersion : null
    : DEFAULT_GRAPH_API_VERSION;
  if (!graphVersion) {
    return { success: false, error: 'WhatsApp Graph API version is invalid' };
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { success: false, error: 'Message text is required' };
  }

  // Meta expects recipient phone number with digits only (no leading + or spaces)
  const cleanRecipient = to.replace(/[^\d]/g, '');
  if (cleanRecipient.length < 7 || cleanRecipient.length > 15) {
    return { success: false, error: 'Recipient WhatsApp number is invalid' };
  }

  const configuredTimeout = Number(getEnv('META_FETCH_TIMEOUT_MS'));
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(Math.floor(configuredTimeout), MAX_META_TIMEOUT_MS)
    : DEFAULT_META_TIMEOUT_MS;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: cleanRecipient,
        type: 'text',
        text: { preview_url: false, body: text }
      }),
      signal: controller.signal
    });

    let data: any = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      return { success: false, error: data?.error?.message || `WhatsApp API error: ${response.status}` };
    }

    const messageId = data?.messages?.[0]?.id;
    if (typeof messageId !== 'string' || messageId.length === 0) {
      return { success: false, error: 'WhatsApp API response did not include a message ID' };
    }

    return { success: true, messageId };
  } catch {
    return { success: false, error: 'Failed to send WhatsApp message' };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Receive and parse incoming WhatsApp messages from Meta webhook.
 */
export function parseWebhookPayload(body: any): { from: string; text: string; type: string; id: string } | null {
  if (body?.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;

    if (value?.messages && value.messages.length > 0) {
      const message = value.messages[0];
      return {
        from: message.from,
        text: message.text?.body?.trim() || '',
        type: message.type || 'text',
        id: message.id
      };
    }
  }

  return null;
}

/**
 * Handle GET webhook verification challenge from Meta.
 */
export function verifyWebhookChallenge(
  mode: string | null,
  token: string | null,
  challenge: string | null
): { isValid: boolean; challenge?: string } {
  const verifyToken = getEnv('META_WEBHOOK_VERIFY_TOKEN');

  if (verifyToken && mode === 'subscribe' && token === verifyToken && challenge) {
    return { isValid: true, challenge };
  }

  return { isValid: false };
}
