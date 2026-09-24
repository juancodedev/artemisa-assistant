import assert from 'node:assert/strict';
import type { Anthropic } from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  DEFAULT_GRAPH_API_VERSION,
  handleWebhookVerification,
  parseWebhookPayload,
  sendMessage,
  verifyMetaSignature,
} from './whatsapp.ts';
import {
  claimIncomingMessage,
  completeIncomingMessage,
  getBoundedHistory,
  markDeliveryUncertain,
  selectPsicologoFromRows,
} from './supabase.ts';
import { aggregateBatchOutcomes } from './batch.ts';
import {
  generateResponse,
  quickAdminAnswer,
  setAnthropicClientForTests,
} from './claude.ts';
import { handleSendMessage } from '../send-message/handler.ts';
import { handleWebhook, type WebhookDependencies } from '../webhook/index.ts';
import type { Psicologo } from './types.ts';

const profile: Psicologo = {
  id: 'profile-1',
  nombre: 'Dra. María López',
  numero_whatsapp: '+5491123456789',
  meta_phone_number_id: 'meta-phone-1',
  modalidad: 'Presencial y Virtual',
  direccion: 'Av. Corrientes 1234',
  precio: '$15.000 ARS',
  tipo_de_cita: 'Sesión individual',
  sistemas_de_salud: ['OSDE'],
  link_calcom: 'https://cal.com/example/profile',
  horarios: null,
};

async function createSignature(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return `sha256=${Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

Deno.test('verifies a valid signature against the exact raw body', async () => {
  const body = '{"object":"whatsapp_business_account"}';
  const signature = await createSignature(body, 'test-app-secret');

  assert.equal(await verifyMetaSignature(body, signature, 'test-app-secret'), true);
  assert.equal(
    await verifyMetaSignature(`${body} `, signature, 'test-app-secret'),
    false
  );
  assert.equal(await verifyMetaSignature(body, signature, null), false);
});

Deno.test('fails closed when the webhook verification token is missing', () => {
  Deno.env.delete('META_WEBHOOK_VERIFY_TOKEN');
  const response = handleWebhookVerification(
    new Request(
      'https://example.test/?hub.mode=subscribe&hub.verify_token=anything&hub.challenge=challenge'
    )
  );
  assert.equal(response.status, 403);
});

Deno.test('sends through Graph API v25.0 and requires a Meta message ID', async () => {
  Deno.env.set('META_PHONE_NUMBER_ID', 'phone-1');
  Deno.env.set('META_ACCESS_TOKEN', 'test-access-token');
  Deno.env.delete('META_GRAPH_API_VERSION');
  Deno.env.delete('META_FETCH_TIMEOUT_MS');

  let requestedUrl = '';
  const successfulFetch: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.sent-1' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const success = await sendMessage('+54 9 11 2345-6789', 'Hola', {
    fetchImpl: successfulFetch,
  });
  assert.equal(success.success, true);
  assert.equal(success.delivery, 'delivered');
  assert.equal(success.messageId, 'wamid.sent-1');
  assert.ok(requestedUrl.includes(`/${DEFAULT_GRAPH_API_VERSION}/`));

  const missingIdFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ messages: [{}] }), { status: 200 });
  };
  const missingId = await sendMessage('5491123456789', 'Hola', {
    fetchImpl: missingIdFetch,
  });
  assert.equal(missingId.success, false);
  assert.equal(missingId.delivery, 'uncertain');
});

Deno.test('fails a Meta send on a non-2xx response and aborts timed-out requests', async () => {
  Deno.env.set('META_PHONE_NUMBER_ID', 'phone-1');
  Deno.env.set('META_ACCESS_TOKEN', 'test-access-token');
  Deno.env.set('META_GRAPH_API_VERSION', 'v25.0');

  const failedFetch: typeof fetch = async () => {
    return new Response(JSON.stringify({ error: { message: 'rejected' } }), {
      status: 500,
    });
  };
  const failed = await sendMessage('5491123456789', 'Hola', {
    fetchImpl: failedFetch,
  });
  assert.equal(failed.success, false);
  assert.equal(failed.delivery, 'failed');

  const timeoutFetch: typeof fetch = (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      if (init && 'signal' in init && init.signal instanceof AbortSignal) {
        init.signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }
    });
  const timedOut = await sendMessage('5491123456789', 'Hola', {
    fetchImpl: timeoutFetch,
    timeoutMs: 5,
  });
  assert.equal(timedOut.success, false);
  assert.equal(timedOut.delivery, 'uncertain');
});

Deno.test('parses every inbound message and preserves status notifications', () => {
  const parsed = parseWebhookPayload({
    object: 'whatsapp_business_account',
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { phone_number_id: 'phone-1' },
              messages: [
                { from: '111', id: 'wamid-1', type: 'text', text: { body: 'Hola' } },
                { from: '111', id: 'wamid-2', type: 'text', text: { body: 'Precio' } },
              ],
            },
          },
        ],
      },
      {
        changes: [{ value: { statuses: [{ id: 'wamid-1', status: 'delivered' }] } }],
      },
    ],
  });

  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].phoneNumberId, 'phone-1');
  assert.equal(parsed.messages[1].text, 'Precio');
  assert.equal(parsed.isStatusNotification, true);
});

Deno.test('does not select a first profile when multiple rows have no matching ID', () => {
  const first = { ...profile, id: 'profile-1', meta_phone_number_id: null };
  const second = { ...profile, id: 'profile-2', meta_phone_number_id: 'phone-2' };

  assert.equal(selectPsicologoFromRows([first, second], 'unknown-phone'), null);
  assert.equal(selectPsicologoFromRows([first, second], 'phone-2')?.id, 'profile-2');
  assert.equal(selectPsicologoFromRows([first], 'unknown-phone')?.id, 'profile-1');
});

Deno.test('acknowledges delivery uncertainty as a duplicate on replay', async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const client = {
    from() {
      let mode: 'insert' | 'select' | 'update' = 'select';
      let wamid = '';
      let status = '';
      let values: Record<string, unknown> = {};

      const query = {
        insert(nextValues: Record<string, unknown>) {
          mode = 'insert';
          values = nextValues;
          return Promise.resolve((async () => {
            if (rows.has(String(values.wamid))) {
              return { data: null, error: { code: '23505' } };
            }
            rows.set(String(values.wamid), { ...values });
            return { data: null, error: null };
          })());
        },
        select() {
          if (mode !== 'update') mode = 'select';
          return query;
        },
        update(nextValues: Record<string, unknown>) {
          mode = 'update';
          values = nextValues;
          return query;
        },
        eq(column: string, value: string) {
          if (column === 'wamid') wamid = value;
          if (column === 'status') status = value;
          return query;
        },
        maybeSingle: async () => {
          const row = rows.get(wamid);
          if (mode === 'insert') return { data: null, error: null };
          if (!row || (status && row.status !== status)) {
            return { data: null, error: { code: 'PGRST116' } };
          }
          if (mode === 'update') {
            rows.set(wamid, { ...row, ...values });
            return { data: { wamid }, error: null };
          }
          return { data: row, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;

  assert.equal(await claimIncomingMessage('wamid-duplicate', client), 'claimed');
  assert.equal(await claimIncomingMessage('wamid-duplicate', client), 'busy');
  assert.equal(await markDeliveryUncertain('wamid-duplicate', client), true);
  assert.equal(rows.get('wamid-duplicate')?.status, 'delivery_uncertain');
  assert.equal(rows.get('wamid-duplicate')?.error_code, 'delivery_uncertain');
  assert.equal(await claimIncomingMessage('wamid-duplicate', client), 'duplicate');

  assert.equal(await claimIncomingMessage('wamid-persistence', client), 'claimed');
  assert.equal(
    await completeIncomingMessage('wamid-persistence', 'persistence_failed', client),
    true
  );
  assert.equal(rows.get('wamid-persistence')?.status, 'completed');
  assert.equal(rows.get('wamid-persistence')?.error_code, 'persistence_failed');
});

Deno.test('treats processing and database errors as retryable claims', async () => {
  const createProbeClient = (
    status: 'processing' | 'failed',
    insertErrorCode: string
  ): SupabaseClient => {
    const row = {
      wamid: 'wamid-busy',
      status,
      processing_started_at: new Date().toISOString(),
    };
    return {
      from() {
        let wamid = '';
        const query = {
          insert: async () => ({ data: null, error: { code: insertErrorCode } }),
          select: () => query,
          eq: (column: string, value: string) => {
            if (column === 'wamid') wamid = value;
            return query;
          },
          maybeSingle: async () => ({ data: row, error: null }),
        };
        return query;
      },
    } as unknown as SupabaseClient;
  };

  assert.equal(
    await claimIncomingMessage('wamid-busy', createProbeClient('processing', '23505')),
    'busy'
  );
  assert.equal(
    await claimIncomingMessage('wamid-busy', createProbeClient('failed', 'DB_ERROR')),
    'uncertain'
  );
});

Deno.test('aggregates retry and busy outcomes after processing the full batch', () => {
  const summary = aggregateBatchOutcomes([
    'completed',
    'duplicate',
    'busy',
    'retry',
  ]);
  assert.equal(summary.httpStatus, 502);
  assert.equal(summary.completed, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.busy, 1);
  assert.equal(summary.retries, 1);

  const uncertainSummary = aggregateBatchOutcomes(['delivery_uncertain']);
  assert.equal(uncertainSummary.httpStatus, 200);
  assert.equal(uncertainSummary.status, 'delivery_uncertain');
  assert.equal(uncertainSummary.deliveryUncertain, 1);
});

Deno.test('accepts a valid raw signature before parsing and rejects altered signatures', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const rawBody = '{not-valid-json';
  const signature = await createSignature(rawBody, 'test-app-secret');
  const makeRequest = (body: string, value: string | null) =>
    new Request('https://example.test/webhook', {
      method: 'POST',
      headers: value ? { 'X-Hub-Signature-256': value } : {},
      body,
    });

  const valid = await handleWebhook(makeRequest(rawBody, signature));
  assert.equal(valid.status, 400);
  assert.equal((await (await handleWebhook(makeRequest(`${rawBody} `, signature))).text()), 'Unauthorized');
  assert.equal((await handleWebhook(makeRequest(rawBody, null))).status, 401);
  assert.equal((await handleWebhook(makeRequest(rawBody, 'sha256=invalid'))).status, 401);
});

Deno.test('attempts every batch message and aggregates one retry', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const rawBody = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'phone-1' },
          messages: [
            { from: '111', id: 'wamid-first', type: 'text', text: { body: 'Primero' } },
            { from: '111', id: 'wamid-second', type: 'text', text: { body: 'Segundo' } },
          ],
        },
      }],
    }],
  });
  let sendCalls = 0;
  const completedWamids: string[] = [];
  const dependencies = createWebhookDependencies({
    sendMessage: (async () => {
      sendCalls += 1;
      return sendCalls === 1
        ? { success: false, delivery: 'failed', error: 'definite rejection' }
        : { success: true, delivery: 'delivered', messageId: 'sent-2' };
    }) as unknown as WebhookDependencies['sendMessage'],
    completeIncomingMessage: (async (wamid: string) => {
      completedWamids.push(wamid);
      return true;
    }) as unknown as WebhookDependencies['completeIncomingMessage'],
  });

  const response = await handleWebhook(
    new Request('https://example.test/webhook', {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': await createSignature(rawBody, 'test-app-secret') },
      body: rawBody,
    }),
    dependencies
  );

  assert.equal(response.status, 502);
  assert.equal(sendCalls, 2);
  assert.deepEqual(completedWamids, ['wamid-second']);
});

Deno.test('completes persistence failures with a durable redacted code', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const rawBody = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ from: '111', id: 'wamid-persist', type: 'text', text: { body: 'Hola' } }] } }] }],
  });
  let completionErrorCode: unknown;
  let failCalled = false;
  const dependencies = createWebhookDependencies({
    appendMessagesToConversacion: (async () => false) as unknown as WebhookDependencies['appendMessagesToConversacion'],
    completeIncomingMessage: (async (_wamid: string, errorCode: unknown) => {
      completionErrorCode = errorCode;
      return true;
    }) as unknown as WebhookDependencies['completeIncomingMessage'],
    failIncomingMessage: (async () => {
      failCalled = true;
      return true;
    }) as unknown as WebhookDependencies['failIncomingMessage'],
  });

  const response = await handleWebhook(
    new Request('https://example.test/webhook', {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': await createSignature(rawBody, 'test-app-secret') },
      body: rawBody,
    }),
    dependencies
  );

  assert.equal(response.status, 200);
  assert.equal(completionErrorCode, 'persistence_failed');
  assert.equal(failCalled, false);
});

Deno.test('acknowledges uncertain Meta delivery without automatic resend', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const rawBody = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ changes: [{ value: { metadata: { phone_number_id: 'phone-1' }, messages: [{ from: '111', id: 'wamid-uncertain', type: 'text', text: { body: 'Hola' } }] } }] }],
  });
  let uncertainWamid: string | null = null;
  let failCalled = false;
  const dependencies = createWebhookDependencies({
    sendMessage: (async () => ({
      success: false,
      delivery: 'uncertain',
      error: 'response lost',
    })) as unknown as WebhookDependencies['sendMessage'],
    markDeliveryUncertain: (async (wamid: string) => {
      uncertainWamid = wamid;
      return true;
    }) as unknown as WebhookDependencies['markDeliveryUncertain'],
    failIncomingMessage: (async () => {
      failCalled = true;
      return true;
    }) as unknown as WebhookDependencies['failIncomingMessage'],
  });

  const response = await handleWebhook(
    new Request('https://example.test/webhook', {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': await createSignature(rawBody, 'test-app-secret') },
      body: rawBody,
    }),
    dependencies
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, 'delivery_uncertain');
  assert.equal(body.deliveryUncertain, 1);
  assert.equal(uncertainWamid, 'wamid-uncertain');
  assert.equal(failCalled, false);
});

function createWebhookDependencies(
  overrides: Partial<WebhookDependencies> = {}
): Partial<WebhookDependencies> {
  return {
    claimIncomingMessage: (async () => 'claimed') as unknown as WebhookDependencies['claimIncomingMessage'],
    sendMessage: (async () => ({ success: true, delivery: 'delivered', messageId: 'sent' })) as unknown as WebhookDependencies['sendMessage'],
    getPsicologo: (async () => profile) as unknown as WebhookDependencies['getPsicologo'],
    getOrCreateConversacion: (async () => ({
      id: 'conversation-1',
      psicologo_id: profile.id,
      numero_paciente: '+111',
      historial: [],
      ultima_actividad: new Date().toISOString(),
    })) as unknown as WebhookDependencies['getOrCreateConversacion'],
    getBoundedHistory: (() => []) as WebhookDependencies['getBoundedHistory'],
    processIncomingMessage: (async () => ({
      success: true,
      response: 'Respuesta',
      tipo: 'administrativa',
      normalizedPatientNumber: '+111',
    })) as unknown as WebhookDependencies['processIncomingMessage'],
    appendMessagesToConversacion: (async () => true) as unknown as WebhookDependencies['appendMessagesToConversacion'],
    completeIncomingMessage: (async () => true) as unknown as WebhookDependencies['completeIncomingMessage'],
    failIncomingMessage: (async () => true) as unknown as WebhookDependencies['failIncomingMessage'],
    markDeliveryUncertain: (async () => true) as unknown as WebhookDependencies['markDeliveryUncertain'],
    ...overrides,
  };
}

Deno.test('bounds history and reports missing hours without inventing them', () => {
  const history = Array.from({ length: 25 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message-${index}`,
    timestamp: new Date(index).toISOString(),
  }));
  const bounded = getBoundedHistory(history, 3);
  assert.equal(bounded.length, 3);
  assert.equal(bounded[0].content, 'message-22');
  assert.match(quickAdminAnswer('¿Cuáles son los horarios?', profile) || '', /No cuento con horarios/);
});

Deno.test('uses bounded Claude request options, all text blocks, and strips generated links', async () => {
  let capturedOptions: { timeout?: number; maxRetries?: number } | undefined;
  let capturedMessages: unknown[] = [];
  const fakeClient = {
    messages: {
      create: async (
        params: { messages: unknown[] },
        options: { timeout?: number; maxRetries?: number }
      ) => {
        capturedMessages = params.messages;
        capturedOptions = options;
        return {
          content: [
            { type: 'text', text: 'El precio es ' },
            { type: 'text', text: 'https://cal.com/example/profile' },
            { type: 'text', text: 'www.cal.com/example/profile' },
            { type: 'text', text: 'cal.com/example/profile' },
          ],
        };
      },
    },
  } as unknown as Anthropic;

  setAnthropicClientForTests(fakeClient);
  const result = await generateResponse('¿Cuánto cuesta?', profile, [
    { role: 'user', content: 'Hola', timestamp: new Date().toISOString() },
  ]);
  setAnthropicClientForTests(null);

  assert.equal(capturedOptions?.timeout, 15_000);
  assert.equal(capturedOptions?.maxRetries, 1);
  assert.equal(capturedMessages.length, 2);
  assert.equal(result.contenido.includes(profile.link_calcom), false);
  assert.equal(result.contenido.includes('www.cal.com'), false);
  assert.equal(result.contenido.includes('cal.com/'), false);
  assert.equal(result.link_calcom, undefined);

  setAnthropicClientForTests({
    messages: { create: async () => ({ content: [] }) },
  } as unknown as Anthropic);
  const empty = await generateResponse('¿Dónde queda?', profile);
  setAnthropicClientForTests(null);
  assert.match(empty.contenido, /revisará tu consulta/);
});

Deno.test('rejects public send-message requests without the internal function secret', async () => {
  Deno.env.set('INTERNAL_FUNCTION_SECRET', 'internal-test-secret');
  const response = await handleSendMessage(
    new Request('https://example.test/send-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: '5491123456789', message: 'Hola' }),
    })
  );
  assert.equal(response.status, 401);
});
