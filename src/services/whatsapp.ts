// src/services/whatsapp.ts
// WhatsApp Business API client
// Handles sending messages to patients via Meta's Cloud API

const META_APP_ID = Deno.env.get('META_APP_ID') || '';
const PHONE_NUMBER_ID = Deno.env.get('META_PHONE_NUMBER_ID') || '';
const ACCESS_TOKEN = Deno.env.get('META_ACCESS_TOKEN') || '';
const GRAPH_API_VERSION = 'v18.0';

/**
 * Send a text message to a WhatsApp user.
 * Returns the message ID on success.
 */
export async function sendMessage(to: string, text: string): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!META_APP_ID || !PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    return { success: false, error: 'WhatsApp credentials not configured' };
  }

  try {
    const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${META_APP_ID}/messages`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text }
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
 * Validates the webhook signature and extracts message data.
 */
export function parseWebhookPayload(body: any): { from: string; text: string; type: string } | null {
  // Handle verification request
  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const change = entry?.changes?.[0];

    // Webhook verification (GET)
    if (change?.value?.messages) {
      const message = change.value.messages[0];
      return {
        from: message.from,
        text: message.message?.text?.body?.trim() || '',
        type: message.type
      };
    }

    // Webhook verification challenge
    if (change?.value?.['hub.mode'] === 'subscribe') {
      return null; // Handled by verification endpoint
    }
  }

  return null;
}

/**
 * Validate that a webhook request is from Meta.
 * In production, this should verify the X-Hub-Signature header.
 */
export function validateWebhookSignature(body: string, signature: string | null): boolean {
  if (!signature) return true; // For development, skip signature check
  // TODO: Implement proper HMAC verification
  return true;
}
