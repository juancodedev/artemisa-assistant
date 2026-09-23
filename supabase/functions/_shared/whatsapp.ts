// supabase/functions/_shared/whatsapp.ts
// WhatsApp Cloud API client (Meta)

const GRAPH_API_VERSION = 'v18.0';

export interface WebhookMessage {
  from: string;
  messageId: string;
  text: string;
  type: string;
  timestamp: string;
}

export interface WebhookParseResult {
  isMessage: boolean;
  message?: WebhookMessage;
  isStatusNotification?: boolean;
}

/**
 * Sends a text message to a WhatsApp user via Meta Cloud API.
 */
export async function sendMessage(
  to: string,
  text: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  const phoneNumberId = Deno.env.get('META_PHONE_NUMBER_ID');
  const accessToken = Deno.env.get('META_ACCESS_TOKEN');

  if (!phoneNumberId || !accessToken) {
    console.error('WhatsApp credentials missing: META_PHONE_NUMBER_ID or META_ACCESS_TOKEN not set');
    return { success: false, error: 'WhatsApp credentials not configured' };
  }

  // Meta expects recipient phone number with digits only (no leading + or spaces)
  const cleanRecipient = to.replace(/[^\d]/g, '');

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  try {
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
        text: {
          preview_url: false,
          body: text,
        },
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error('Meta WhatsApp API error response:', data);
      return {
        success: false,
        error: data.error?.message || `WhatsApp API error: ${response.status}`,
      };
    }

    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (error) {
    console.error('Network error sending WhatsApp message:', error);
    return { success: false, error: 'Failed to send WhatsApp message' };
  }
}

/**
 * Parse an incoming webhook payload from Meta WhatsApp Cloud API.
 */
export function parseWebhookPayload(body: any): WebhookParseResult {
  if (body?.object !== 'whatsapp_business_account') {
    return { isMessage: false };
  }

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const value = change?.value;

  if (!value) {
    return { isMessage: false };
  }

  // Check if it's a delivery status update (sent, delivered, read)
  if (value.statuses && value.statuses.length > 0) {
    return { isMessage: false, isStatusNotification: true };
  }

  // Check for incoming customer messages
  if (value.messages && value.messages.length > 0) {
    const message = value.messages[0];
    const textBody = message.text?.body?.trim() || '';

    return {
      isMessage: true,
      message: {
        from: message.from,
        messageId: message.id,
        text: textBody,
        type: message.type || 'text',
        timestamp: message.timestamp || String(Math.floor(Date.now() / 1000)),
      },
    };
  }

  return { isMessage: false };
}

/**
 * Handle Meta webhook GET verification challenge.
 */
export function handleWebhookVerification(req: Request): Response {
  const url = new URL(req.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  const configuredToken = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN') || 'artemisa-verify-token';

  if (mode === 'subscribe' && token === configuredToken && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return new Response('Forbidden: Invalid verification token', { status: 403 });
}
