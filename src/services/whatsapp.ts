// src/services/whatsapp.ts
// WhatsApp Business Cloud API client

const GRAPH_API_VERSION = 'v18.0';

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

  // Meta expects recipient phone number with digits only (no leading + or spaces)
  const cleanRecipient = to.replace(/[^\d]/g, '');

  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

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
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return { success: false, error: data.error?.message || `WhatsApp API error: ${response.status}` };
    }

    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    console.error('WhatsApp send error:', error);
    return { success: false, error: 'Failed to send WhatsApp message' };
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
  const verifyToken = getEnv('META_WEBHOOK_VERIFY_TOKEN') || 'artemisa-verify-token';

  if (mode === 'subscribe' && token === verifyToken && challenge) {
    return { isValid: true, challenge };
  }

  return { isValid: false };
}
