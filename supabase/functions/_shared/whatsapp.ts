// supabase/functions/_shared/whatsapp.ts
// WhatsApp Cloud API client and Meta webhook verification primitives.

export const DEFAULT_GRAPH_API_VERSION = 'v25.0';
export const DEFAULT_META_TIMEOUT_MS = 10_000;
export const MAX_META_TIMEOUT_MS = 30_000;
const GRAPH_API_VERSION_PATTERN = /^v\d{1,3}\.\d{1,3}$/;

export type FetchLike = typeof fetch;

export interface SendMessageOptions {
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface WebhookMessage {
  from: string;
  messageId: string;
  text: string;
  type: string;
  timestamp: string;
  phoneNumberId?: string;
}

export interface WebhookParseResult {
  isMessage: boolean;
  messages: WebhookMessage[];
  /** Backwards-compatible alias for callers that consume one message. */
  message?: WebhookMessage;
  isStatusNotification: boolean;
}

export type DeliveryStatus = 'delivered' | 'failed' | 'uncertain';

export interface SendMessageResult {
  success: boolean;
  delivery: DeliveryStatus;
  messageId?: string;
  error?: string;
}

function getEnv(name: string): string {
  try {
    return Deno.env.get(name) || '';
  } catch {
    return '';
  }
}

/**
 * Return the configured Graph API version only when it matches the strict allow-list pattern.
 */
export function getGraphApiVersion(): string | null {
  const configuredVersion = getEnv('META_GRAPH_API_VERSION');
  if (!configuredVersion) return DEFAULT_GRAPH_API_VERSION;
  return GRAPH_API_VERSION_PATTERN.test(configuredVersion) ? configuredVersion : null;
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_META_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_META_TIMEOUT_MS);
}

/**
 * Send a text message to a WhatsApp user via Meta Cloud API.
 * A 2xx response without a Meta message ID is not considered successful.
 */
export async function sendMessage(
  to: string,
  text: string,
  options: SendMessageOptions = {}
): Promise<SendMessageResult> {
  const phoneNumberId = getEnv('META_PHONE_NUMBER_ID');
  const accessToken = getEnv('META_ACCESS_TOKEN');
  const graphApiVersion = getGraphApiVersion();

  if (!phoneNumberId || !accessToken) {
    console.error('WhatsApp credentials are not configured');
    return { success: false, delivery: 'failed', error: 'WhatsApp credentials not configured' };
  }

  if (!graphApiVersion) {
    console.error('META_GRAPH_API_VERSION does not match the expected format');
    return { success: false, delivery: 'failed', error: 'WhatsApp Graph API version is invalid' };
  }

  if (typeof text !== 'string' || text.trim().length === 0) {
    return { success: false, delivery: 'failed', error: 'Message text is required' };
  }

  const cleanRecipient = to.replace(/[^\d]/g, '');
  if (cleanRecipient.length < 7 || cleanRecipient.length > 15) {
    return { success: false, delivery: 'failed', error: 'Recipient WhatsApp number is invalid' };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const configuredTimeout = Number(getEnv('META_FETCH_TIMEOUT_MS'));
  const timeoutMs = boundedTimeout(options.timeoutMs ?? configuredTimeout);
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  const url = `https://graph.facebook.com/${graphApiVersion}/${phoneNumberId}/messages`;

  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
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
      signal: controller.signal,
    });

    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      console.error(`Meta WhatsApp API returned HTTP ${response.status}`);
      const errorMessage =
        typeof data === 'object' && data !== null && 'error' in data
          ? (data as { error?: { message?: string } }).error?.message
          : undefined;
      return {
        success: false,
        delivery: 'failed',
        error: errorMessage || `WhatsApp API error: ${response.status}`,
      };
    }

    const messageId =
      typeof data === 'object' && data !== null && 'messages' in data
        ? (data as { messages?: Array<{ id?: unknown }> }).messages?.[0]?.id
        : undefined;

    if (typeof messageId !== 'string' || messageId.length === 0) {
      console.error('Meta WhatsApp API response did not include a message ID');
      return {
        success: false,
        delivery: 'uncertain',
        error: 'WhatsApp API response did not include a message ID',
      };
    }

    return { success: true, delivery: 'delivered', messageId };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      console.error('Meta WhatsApp API request timed out');
      return { success: false, delivery: 'uncertain', error: 'WhatsApp API request timed out' };
    }
    console.error('Meta WhatsApp API request failed');
    return { success: false, delivery: 'uncertain', error: 'Failed to send WhatsApp message' };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

/**
 * Parse every Meta entry/change/message while retaining status notifications.
 */
export function parseWebhookPayload(body: unknown): WebhookParseResult {
  const result: WebhookParseResult = {
    isMessage: false,
    messages: [],
    isStatusNotification: false,
  };

  if (!body || typeof body !== 'object') return result;
  const payload = body as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        value?: {
          metadata?: { phone_number_id?: string };
          statuses?: unknown[];
          messages?: unknown[];
        };
      }>;
    }>;
  };

  if (payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return result;
  }

  for (const entry of payload.entry) {
    if (!entry || !Array.isArray(entry.changes)) continue;

    for (const change of entry.changes) {
      const value = change?.value;
      if (!value) continue;

      if (Array.isArray(value.statuses) && value.statuses.length > 0) {
        result.isStatusNotification = true;
      }

      if (!Array.isArray(value.messages)) continue;
      const phoneNumberId =
        typeof value.metadata?.phone_number_id === 'string'
          ? value.metadata.phone_number_id
          : undefined;

      for (const rawMessage of value.messages) {
        if (!rawMessage || typeof rawMessage !== 'object') continue;
        const message = rawMessage as {
          from?: unknown;
          id?: unknown;
          text?: { body?: unknown };
          type?: unknown;
          timestamp?: unknown;
        };

        if (typeof message.from !== 'string' || typeof message.id !== 'string') continue;

        const text = typeof message.text?.body === 'string' ? message.text.body.trim() : '';
        result.messages.push({
          from: message.from,
          messageId: message.id,
          text,
          type: typeof message.type === 'string' ? message.type : 'text',
          timestamp:
            typeof message.timestamp === 'string'
              ? message.timestamp
              : String(Math.floor(Date.now() / 1000)),
          phoneNumberId,
        });
      }
    }
  }

  result.isMessage = result.messages.length > 0;
  result.message = result.messages[0];
  return result;
}

function constantTimeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;

  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }

  return difference === 0;
}

function hexToBytes(value: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(value)) return null;

  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Verify Meta's sha256 HMAC against the exact raw request body.
 * Web Crypto signs the raw bytes; the digest comparison below is constant-time.
 */
export async function verifyMetaSignature(
  rawBody: string,
  signature: string | null,
  appSecret: string | null
): Promise<boolean> {
  if (!appSecret || !signature || !signature.startsWith('sha256=')) return false;

  const providedBytes = hexToBytes(signature.slice('sha256='.length));
  if (!providedBytes) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody))
  );

  return constantTimeEqualBytes(digest, providedBytes);
}

/**
 * Handle Meta webhook GET verification challenge. Missing configuration fails closed.
 */
export function handleWebhookVerification(request: Request): Response {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');
  const configuredToken = getEnv('META_WEBHOOK_VERIFY_TOKEN');

  if (configuredToken && mode === 'subscribe' && token === configuredToken && challenge) {
    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return new Response('Forbidden: Invalid verification token', { status: 403 });
}
