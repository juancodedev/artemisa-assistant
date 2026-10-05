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
  consumeRateLimitSlot,
  getBoundedHistory,
  getOrCreateConversacion,
  getPsicologo,
  hasSenderConsent,
  markDeliveryUncertain,
  recordSenderConsent,
  selectPsicologoFromRows,
} from './supabase.ts';
import { aggregateBatchOutcomes } from './batch.ts';
import {
  generateResponse,
  quickAdminAnswer,
  setAnthropicClientForTests,
} from './claude.ts';
import {
  CRISIS_RESPONSE,
  greetingResponse,
  routeDeterministicMessage,
  routeMessage,
} from './router.ts';
import {
  CONSENT_REQUEST,
  RATE_LIMIT_RESPONSE,
  evaluateGate,
  isOptInToken,
} from './gate.ts';
import { isCrisisSignal } from './validation.ts';
import { handleSendMessage } from '../send-message/handler.ts';
import { handleWebhook, type WebhookDependencies } from '../webhook/index.ts';
import type { MensajeHistoria, Psicologo } from './types.ts';

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

interface StubStatement {
  kind: 'upsert' | 'select' | 'insert' | 'update';
  table: string;
  onConflict?: string;
  filters: Array<[string, unknown]>;
  limit: number | null;
  payload: Record<string, unknown> | null;
  // Present only on statements issued through client.rpc(), so a test can assert which
  // database function was called and not only that something was called.
  rpcFunction?: string;
}

function applyStubFilters(
  rows: Array<Record<string, unknown>>,
  statement: StubStatement
): Array<Record<string, unknown>> {
  const matched = rows.filter((row) =>
    statement.filters.every(([column, value]) => row[column] === value)
  );
  return statement.limit === null ? matched : matched.slice(0, statement.limit);
}

/**
 * Stubs the psicologos table and records every statement the module issues, so a
 * test can assert the shape of the query and not only its result.
 */
function createPsicologosStub(
  rows: Array<Record<string, unknown>>,
  statements: StubStatement[]
): SupabaseClient {
  return {
    from(table: string) {
      const statement: StubStatement = {
        kind: 'select',
        table,
        filters: [],
        limit: null,
        payload: null,
      };
      const query = {
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          statement.filters.push([column, value]);
          return query;
        },
        // The real builder is thenable, so awaiting the chain terminates here.
        limit(value: number) {
          statement.limit = value;
          statements.push(statement);
          return Promise.resolve({ data: applyStubFilters(rows, statement), error: null });
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

/**
 * Stubs conversaciones with the uniqueness behavior the migration 005 constraint
 * provides, and records every statement so a test can prove the resolution is one
 * atomic upsert instead of a read-then-write pair.
 */
function createConversacionesStub(statements: StubStatement[]): SupabaseClient {
  const rows = new Map<string, Record<string, unknown>>();
  let createdCount = 0;

  return {
    from(table: string) {
      const statement: StubStatement = {
        kind: 'select',
        table,
        filters: [],
        limit: null,
        payload: null,
      };
      const query = {
        upsert(
          payload: Record<string, unknown>,
          options?: { onConflict?: string }
        ) {
          statement.kind = 'upsert';
          statement.payload = payload;
          statement.onConflict = options?.onConflict;
          return query;
        },
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          statement.filters.push([column, value]);
          return query;
        },
        limit(value: number) {
          statement.limit = value;
          return query;
        },
        async single() {
          statements.push(statement);
          if (statement.kind === 'upsert') {
            const key = `${statement.payload?.psicologo_id}|${statement.payload?.numero_paciente}`;
            const existing = rows.get(key);
            if (existing) {
              // DO UPDATE SET only touches the columns present in the payload.
              const merged = { ...existing, ...statement.payload };
              rows.set(key, merged);
              return { data: merged, error: null };
            }
            const timestamp = new Date().toISOString();
            const created = {
              id: `conversation-${++createdCount}`,
              historial: [],
              created_at: timestamp,
              updated_at: timestamp,
              ...statement.payload,
            };
            rows.set(key, created);
            return { data: created, error: null };
          }

          const matched = applyStubFilters([...rows.values()], statement);
          if (matched.length !== 1) return { data: null, error: { code: 'PGRST116' } };
          return { data: matched[0], error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

/**
 * Stubs sender_consents with the unique (psicologo_id, numero_remitente) behavior the
 * migration 006 constraint provides, and records every statement so a test can prove
 * the idempotent opt-in is one upsert and that its payload carries nothing but the
 * conflict target.
 */
function createSenderConsentsStub(statements: StubStatement[]): SupabaseClient {
  const rows = new Map<string, Record<string, unknown>>();

  return {
    from(table: string) {
      const statement: StubStatement = {
        kind: 'select',
        table,
        filters: [],
        limit: null,
        payload: null,
      };
      const query = {
        upsert(
          payload: Record<string, unknown>,
          options?: { onConflict?: string }
        ) {
          statement.kind = 'upsert';
          statement.payload = payload;
          statement.onConflict = options?.onConflict;
          return query;
        },
        select() {
          return query;
        },
        eq(column: string, value: unknown) {
          statement.filters.push([column, value]);
          return query;
        },
        limit(value: number) {
          statement.limit = value;
          return query;
        },
        async maybeSingle() {
          statements.push(statement);
          if (statement.kind === 'upsert') {
            const key = `${statement.payload?.psicologo_id}|${statement.payload?.numero_remitente}`;
            const existing = rows.get(key);
            if (existing) {
              // DO UPDATE SET only touches the columns present in the payload, which is
              // what keeps a repeat opt-in from restating opted_in_at.
              const merged = { ...existing, ...statement.payload };
              rows.set(key, merged);
              return { data: merged, error: null };
            }
            const timestamp = new Date().toISOString();
            const created = {
              opted_in_at: timestamp,
              origen: 'whatsapp_optin',
              created_at: timestamp,
              ...statement.payload,
            };
            rows.set(key, created);
            return { data: created, error: null };
          }

          const matched = applyStubFilters([...rows.values()], statement);
          // maybeSingle resolves null for zero rows and errors for more than one.
          if (matched.length > 1) return { data: null, error: { code: 'PGRST117' } };
          return { data: matched[0] ?? null, error: null };
        },
      };
      return query;
    },
  } as unknown as SupabaseClient;
}

/**
 * Stubs consume_sender_rate_limit_slot with the increment semantics migration 006
 * defines: a single statement that adds 1 to the bucket identified by the whole primary
 * key and returns the result, so a second call in the same window yields 2 instead of
 * overwriting the first with 1.
 *
 * That "adds 1 rather than overwrites" property is a property of the SQL, and it is
 * verified against real Postgres in T7. What this stub proves is the half that belongs
 * to the TypeScript: exactly one round trip per consumed slot, the right function, and
 * a payload that is precisely the bucket key with nothing that could clobber a column
 * the caller meant to leave alone.
 */
function createRateBucketStub(statements: StubStatement[]): SupabaseClient {
  const rows = new Map<string, number>();

  return {
    rpc(rpcFunction: string, params: Record<string, unknown>) {
      const statement: StubStatement = {
        kind: 'upsert',
        table: 'sender_rate_buckets',
        onConflict: 'psicologo_id,numero_remitente,window_started_at',
        filters: [],
        limit: null,
        payload: params,
        rpcFunction,
      };
      statements.push(statement);

      // INSERT ... ON CONFLICT DO UPDATE SET message_count = bucket.message_count + 1
      const key = `${params.p_psicologo_id}|${params.p_numero_remitente}|${params.p_window_started_at}`;
      const next = (rows.get(key) ?? 0) + 1;
      rows.set(key, next);
      return Promise.resolve({ data: next, error: null });
    },
  } as unknown as SupabaseClient;
}

Deno.test('resolves the profile through the indexed phone number lookup, never a scan', async () => {
  const statements: StubStatement[] = [];
  const client = createPsicologosStub(
    [
      { ...profile, id: 'profile-1', meta_phone_number_id: 'meta-phone-1' },
      { ...profile, id: 'profile-2', meta_phone_number_id: 'meta-phone-2' },
    ],
    statements
  );

  const resolved = await getPsicologo('meta-phone-2', client);

  assert.equal(resolved?.id, 'profile-2');
  // The partial unique index on meta_phone_number_id can only be used by a filtered
  // query, so an unfiltered select('*') is the regression being guarded against.
  assert.equal(statements.every((statement) => statement.filters.length > 0), true);
  assert.deepEqual(statements[0].filters, [['meta_phone_number_id', 'meta-phone-2']]);
  assert.equal(statements[0].limit, 1);
  // The indexed query answered it, so no fallback query was needed at all.
  assert.equal(statements.length, 1);
});

Deno.test('falls back to the sole profile and refuses to guess between profiles', async () => {
  const soleProfile: StubStatement[] = [];
  const sole = await getPsicologo(
    'unknown-phone',
    createPsicologosStub([{ ...profile, id: 'profile-1', meta_phone_number_id: null }], soleProfile)
  );

  assert.equal(sole?.id, 'profile-1');
  assert.equal(soleProfile.length, 2);
  assert.deepEqual(soleProfile[0].filters, [['meta_phone_number_id', 'unknown-phone']]);
  // The fallback stays bounded at two rows instead of reading the whole table.
  assert.deepEqual(soleProfile[1].filters, []);
  assert.equal(soleProfile[1].limit, 2);

  const ambiguousStatements: StubStatement[] = [];
  const ambiguous = await getPsicologo(
    'unknown-phone',
    createPsicologosStub(
      [
        { ...profile, id: 'profile-1', meta_phone_number_id: null },
        { ...profile, id: 'profile-2', meta_phone_number_id: 'meta-phone-2' },
      ],
      ambiguousStatements
    )
  );

  assert.equal(ambiguous, null);
  assert.equal(ambiguousStatements[ambiguousStatements.length - 1].limit, 2);

  // With no phone number id at all, only the bounded fallback runs.
  const withoutId: StubStatement[] = [];
  assert.equal(
    (
      await getPsicologo(
        undefined,
        createPsicologosStub(
          [{ ...profile, id: 'profile-1', meta_phone_number_id: null }],
          withoutId
        )
      )
    )?.id,
    'profile-1'
  );
  assert.equal(withoutId.length, 1);
  assert.deepEqual(withoutId[0].filters, []);
  assert.equal(withoutId[0].limit, 2);
});

Deno.test('resolves a conversation with one atomic upsert instead of read-then-write', async () => {
  const statements: StubStatement[] = [];
  const client = createConversacionesStub(statements);

  const first = await getOrCreateConversacion('profile-1', '+111', client);
  const second = await getOrCreateConversacion('profile-1', '+111', client);

  assert.equal(first?.id, 'conversation-1');
  // Same logical conversation, same row, so the patient history stays in one place.
  assert.equal(second?.id, first?.id);
  assert.equal(statements.length, 2);
  // Both statements are upserts: no read is issued before the write, which is exactly
  // the race that used to create duplicate conversations.
  assert.deepEqual(statements.map((statement) => statement.kind), ['upsert', 'upsert']);
  assert.equal(statements[0].onConflict, 'psicologo_id,numero_paciente');
  // The conflict target must be in the payload for PostgREST to build ON CONFLICT,
  // and created_at must be absent so the duplicate path cannot clobber it.
  assert.equal(statements[0].payload?.psicologo_id, 'profile-1');
  assert.equal(statements[0].payload?.numero_paciente, '+111');
  assert.equal('created_at' in (statements[0].payload ?? {}), false);
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

/**
 * Builds a single-message webhook request, so a test only states the body it cares about.
 */
async function buildWebhookRequest(messageBody: string, wamid: string): Promise<Request> {
  const rawBody = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'phone-1' },
          messages: [{ from: '111', id: wamid, type: 'text', text: { body: messageBody } }],
        },
      }],
    }],
  });
  return new Request('https://example.test/webhook', {
    method: 'POST',
    headers: { 'X-Hub-Signature-256': await createSignature(rawBody, 'test-app-secret') },
    body: rawBody,
  });
}

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
    // The gate defaults to an already-consented sender within the first slot. That is
    // not a shortcut: before the gate existed every sender was served the full pipeline,
    // so "consented" is the pre-gate condition and it keeps each existing test on the
    // path it was written to assert. The unconsented paths are covered separately below.
    // The real evaluateGate runs here on purpose; only its data access is stubbed, so
    // those tests exercise the real decision order rather than a pinned decision.
    evaluateGate,
    hasSenderConsent: (async () => true) as unknown as WebhookDependencies['hasSenderConsent'],
    recordSenderConsent: (async () => true) as unknown as WebhookDependencies['recordSenderConsent'],
    consumeRateLimitSlot: (async () => 1) as unknown as WebhookDependencies['consumeRateLimitSlot'],
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

Deno.test('prioritizes crisis signals over scheduling and never calls Claude', async () => {
  const messages = [
    'quiero suicidarme',
    'pienso hacerme daño',
    'me quiero lastimar',
    'quiero agendar y quiero morir',
    'NO QUIERO VIVIR',
    'no vale la pena vivir',
    'quiero quitarme la vida',
    'pienso autolesionarme'
  ];
  let claudeCalls = 0;
  setAnthropicClientForTests({
    messages: {
      create: async () => {
        claudeCalls += 1;
        return { content: [{ type: 'text', text: 'no debe usarse' }] };
      },
    },
  } as unknown as Anthropic);

  for (const message of messages) {
    const result = await routeMessage(message, profile);
    assert.equal(isCrisisSignal(message), true);
    assert.equal(result.tipo, 'crisis');
    assert.equal(result.contenido, CRISIS_RESPONSE);
    assert.ok(result.contenido.includes('*4141'));
    assert.ok(result.contenido.includes('600 360 7777'));
    assert.ok(result.contenido.includes('opción 2'));
    assert.ok(result.contenido.includes('gratis'));
    assert.ok(result.contenido.includes('confidencialmente'));
    assert.ok(result.contenido.includes('24 horas'));
    assert.ok(result.contenido.includes('no reemplaza la atención profesional'));
    assert.equal(result.contenido.includes('cal.com'), false);
    assert.equal(result.contenido.includes('contactará'), false);
  }

  setAnthropicClientForTests(null);
  assert.equal(claudeCalls, 0);
});

Deno.test('keeps the ordinary clinical response separate from crisis routing', async () => {
  const result = await routeMessage('Tengo mucha ansiedad y no puedo dormir', profile);
  assert.equal(result.tipo, 'clinica');
  assert.equal(result.contenido, `Esta consulta requiere atención directa con tu psicólogo/a. ${profile.nombre} te contactará a la brevedad.`);
});

Deno.test('redacts raw crisis text while persisting the safety interaction', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const rawCrisisText = 'quiero suicidarme';
  let persistedMessages: Array<{ role: string; content: string }> = [];
  const dependencies = createWebhookDependencies({
    processIncomingMessage: (async () => ({
      success: true,
      response: CRISIS_RESPONSE,
      tipo: 'crisis',
      normalizedPatientNumber: '+111',
    })) as unknown as WebhookDependencies['processIncomingMessage'],
    appendMessagesToConversacion: (async (
      _id: string,
      _history: MensajeHistoria[],
      newMessages: MensajeHistoria[]
    ) => {
      persistedMessages = newMessages;
      return true;
    }) as unknown as WebhookDependencies['appendMessagesToConversacion'],
  });
  const rawBody = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'phone-1' },
          messages: [{ from: '111', id: 'wamid-crisis', type: 'text', text: { body: rawCrisisText } }],
        },
      }],
    }],
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
  assert.equal(persistedMessages[0].content, '[mensaje de crisis omitido]');
  assert.equal(persistedMessages[0].content.includes(rawCrisisText), false);
  assert.equal(persistedMessages[1].content, CRISIS_RESPONSE);
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

// ---------------------------------------------------------------------------
// Opt-in gate: rate limiting and sender consent
// ---------------------------------------------------------------------------

/**
 * Records every outbound reply and every pipeline call the webhook makes, so a test can
 * assert what a sender was told AND what was never reached.
 */
function createGateProbe() {
  const sentTexts: string[] = [];
  let claudeCalls = 0;
  let conversationLookups = 0;
  let persistedConversations = 0;
  const completedWamids: string[] = [];

  return {
    sentTexts,
    completedWamids,
    get claudeCalls() {
      return claudeCalls;
    },
    get conversationLookups() {
      return conversationLookups;
    },
    get persistedConversations() {
      return persistedConversations;
    },
    overrides(consented: boolean, slotCount: number | null = 1): Partial<WebhookDependencies> {
      return {
        sendMessage: (async (_to: string, text: string) => {
          sentTexts.push(text);
          return { success: true, delivery: 'delivered', messageId: 'sent' };
        }) as unknown as WebhookDependencies['sendMessage'],
        getOrCreateConversacion: (async () => {
          conversationLookups += 1;
          return {
            id: 'conversation-1',
            psicologo_id: profile.id,
            numero_paciente: '+111',
            historial: [],
            ultima_actividad: new Date().toISOString(),
          };
        }) as unknown as WebhookDependencies['getOrCreateConversacion'],
        processIncomingMessage: (async () => {
          claudeCalls += 1;
          return {
            success: true,
            response: 'Respuesta generada',
            tipo: 'administrativa',
            normalizedPatientNumber: '+111',
          };
        }) as unknown as WebhookDependencies['processIncomingMessage'],
        appendMessagesToConversacion: (async () => {
          persistedConversations += 1;
          return true;
        }) as unknown as WebhookDependencies['appendMessagesToConversacion'],
        completeIncomingMessage: (async (wamid: string) => {
          completedWamids.push(wamid);
          return true;
        }) as unknown as WebhookDependencies['completeIncomingMessage'],
        hasSenderConsent: (async () => consented) as unknown as WebhookDependencies['hasSenderConsent'],
        consumeRateLimitSlot: (async () =>
          slotCount) as unknown as WebhookDependencies['consumeRateLimitSlot'],
      };
    },
  };
}

Deno.test('keeps a non-consented sender away from Claude and away from stored history', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const probe = createGateProbe();
  const response = await handleWebhook(
    await buildWebhookRequest('Hola, ¿me contás sobre vos?', 'wamid-stranger'),
    createWebhookDependencies(probe.overrides(false))
  );

  assert.equal(response.status, 200);
  // The message was answered and completed: an unconsented sender is not retried.
  assert.equal(probe.sentTexts.length, 1);
  assert.deepEqual(probe.completedWamids, ['wamid-stranger']);
  // Nothing expensive and nothing persistent happened.
  assert.equal(probe.claudeCalls, 0);
  assert.equal(probe.persistedConversations, 0);
  // And no conversation row was created either, which is why the gate runs first.
  assert.equal(probe.conversationLookups, 0);
  // A free-form question has no deterministic answer, so the greeting plus the explicit
  // consent request is what the sender is told.
  assert.ok(probe.sentTexts[0].includes(greetingResponse(profile).contenido));
  assert.ok(probe.sentTexts[0].includes(CONSENT_REQUEST));
});

Deno.test('answers listing questions for a non-consented sender and asks for consent', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  // A consented sender would get these for free; the point is that an unconsented one
  // gets exactly the same listing data plus a consent request, and no Claude call.
  const cases: Array<{ body: string; expected: string[] }> = [
    { body: '¿Cuál es el precio?', expected: [profile.precio] },
    { body: '¿Dónde queda el consultorio?', expected: [profile.direccion] },
    { body: 'quiero agendar una cita', expected: [profile.link_calcom] },
  ];

  for (const [index, testCase] of cases.entries()) {
    const probe = createGateProbe();
    const response = await handleWebhook(
      await buildWebhookRequest(testCase.body, `wamid-listing-${index}`),
      createWebhookDependencies(probe.overrides(false))
    );

    assert.equal(response.status, 200);
    assert.equal(probe.sentTexts.length, 1);
    for (const fragment of testCase.expected) {
      assert.ok(
        probe.sentTexts[0].includes(fragment),
        `expected the reply to include ${fragment}`
      );
    }
    // Every listing answer still carries the explicit consent request.
    assert.ok(probe.sentTexts[0].includes(CONSENT_REQUEST));
    assert.ok(probe.sentTexts[0].includes('QUIERO'));
    assert.equal(probe.claudeCalls, 0);
    assert.equal(probe.persistedConversations, 0);
    assert.equal(probe.conversationLookups, 0);
  }
});

Deno.test('answers a crisis signal from a non-consented rate-limited sender with the crisis line', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  let consentChecks = 0;
  let slotConsumptions = 0;
  const sentTexts: string[] = [];
  const dependencies = createWebhookDependencies({
    hasSenderConsent: (async () => {
      consentChecks += 1;
      return false;
    }) as unknown as WebhookDependencies['hasSenderConsent'],
    // Far above both ceilings, so this sender is rate limited in either consent state.
    consumeRateLimitSlot: (async () => {
      slotConsumptions += 1;
      return 9_999;
    }) as unknown as WebhookDependencies['consumeRateLimitSlot'],
    sendMessage: (async (_to: string, text: string) => {
      sentTexts.push(text);
      return { success: true, delivery: 'delivered', messageId: 'sent' };
    }) as unknown as WebhookDependencies['sendMessage'],
    processIncomingMessage: (async () => ({
      success: true,
      response: CRISIS_RESPONSE,
      tipo: 'crisis',
      normalizedPatientNumber: '+111',
    })) as unknown as WebhookDependencies['processIncomingMessage'],
  });

  const response = await handleWebhook(
    await buildWebhookRequest('quiero suicidarme', 'wamid-crisis-limited'),
    dependencies
  );

  assert.equal(response.status, 200);
  assert.deepEqual(sentTexts, [CRISIS_RESPONSE]);
  // Crisis precedes BOTH gates: neither the rate limit nor consent was even consulted,
  // so no ceiling and no consent state could ever have stood in front of this answer.
  assert.equal(slotConsumptions, 0);
  assert.equal(consentChecks, 0);
  // It took the full existing path, including the existing crisis redaction on persist.
  assert.equal(RATE_LIMIT_RESPONSE.includes(CRISIS_RESPONSE), false);
});

Deno.test('traverses the existing pipeline unchanged for a consented sender', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  let claudeCalls = 0;
  let conversationLookups = 0;
  let persistedHistory: MensajeHistoria[] = [];
  let completionErrorCode: unknown = 'not-called';
  let boundedHistory: unknown[] | null = null;
  const sentTexts: string[] = [];
  const dependencies = createWebhookDependencies({
    getOrCreateConversacion: (async () => {
      conversationLookups += 1;
      return {
        id: 'conversation-1',
        psicologo_id: profile.id,
        numero_paciente: '+111',
        historial: [{ role: 'user', content: 'Hola', timestamp: new Date().toISOString() }],
        ultima_actividad: new Date().toISOString(),
      };
    }) as unknown as WebhookDependencies['getOrCreateConversacion'],
    getBoundedHistory: ((history: unknown) => {
      boundedHistory = getBoundedHistory(history, 20);
      return boundedHistory;
    }) as WebhookDependencies['getBoundedHistory'],
    processIncomingMessage: (async (
      _sender: string,
      _text: string,
      _psicologo: Psicologo,
      history: MensajeHistoria[]
    ) => {
      claudeCalls += 1;
      assert.equal(history.length, 1);
      return {
        success: true,
        response: 'La consulta es de $15.000.',
        tipo: 'administrativa',
        normalizedPatientNumber: '+111',
      };
    }) as unknown as WebhookDependencies['processIncomingMessage'],
    appendMessagesToConversacion: (async (
      _id: string,
      _history: MensajeHistoria[],
      newMessages: MensajeHistoria[]
    ) => {
      persistedHistory = newMessages;
      return true;
    }) as unknown as WebhookDependencies['appendMessagesToConversacion'],
    sendMessage: (async (_to: string, text: string) => {
      sentTexts.push(text);
      return { success: true, delivery: 'delivered', messageId: 'sent' };
    }) as unknown as WebhookDependencies['sendMessage'],
    completeIncomingMessage: (async (_wamid: string, errorCode: unknown) => {
      completionErrorCode = errorCode;
      return true;
    }) as unknown as WebhookDependencies['completeIncomingMessage'],
  });

  const response = await handleWebhook(
    await buildWebhookRequest('¿Cuánto cuesta la sesión?', 'wamid-consented'),
    dependencies
  );

  assert.equal(response.status, 200);
  // Same routing, same history read, same persistence, same idempotent completion.
  assert.equal(conversationLookups, 1);
  assert.equal(claudeCalls, 1);
  assert.ok(boundedHistory !== null);
  assert.equal(persistedHistory.length, 2);
  assert.equal(persistedHistory[0].role, 'user');
  assert.equal(persistedHistory[1].content, 'La consulta es de $15.000.');
  // Completion carries no error code, which is the ordinary successful terminal state.
  assert.equal(completionErrorCode, null);
  assert.deepEqual(sentTexts, ['La consulta es de $15.000.']);
});

Deno.test('confirms an opt-in token without Claude, without a conversation row, and without retrying', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const probe = createGateProbe();
  let recordedFor: Array<[string, string]> = [];
  const dependencies = createWebhookDependencies({
    ...probe.overrides(false),
    recordSenderConsent: (async (psicologoId: string, senderNumber: string) => {
      recordedFor.push([psicologoId, senderNumber]);
      return true;
    }) as unknown as WebhookDependencies['recordSenderConsent'],
  });

  const response = await handleWebhook(
    await buildWebhookRequest('QUIERO', 'wamid-optin'),
    dependencies
  );

  assert.equal(response.status, 200);
  // Consent is scoped to the resolved psychologist and the normalized sender number.
  assert.deepEqual(recordedFor, [[profile.id, '+111']]);
  assert.equal(probe.sentTexts.length, 1);
  assert.ok(probe.sentTexts[0].includes('Perfecto, registré tu consentimiento.'));
  assert.ok(probe.sentTexts[0].includes(greetingResponse(profile).contenido));
  // No Claude, no conversation row, and completed so Meta never redelivers the token.
  assert.equal(probe.claudeCalls, 0);
  assert.equal(probe.conversationLookups, 0);
  assert.equal(probe.persistedConversations, 0);
  assert.deepEqual(probe.completedWamids, ['wamid-optin']);
});

Deno.test('sends the over-limit text and completes instead of asking Meta to retry', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  const probe = createGateProbe();
  const dependencies = createWebhookDependencies(probe.overrides(false, 11));

  const response = await handleWebhook(
    await buildWebhookRequest('Hola', 'wamid-over-limit'),
    dependencies
  );

  // 200, not the 502 that a 'retry' outcome would produce.
  assert.equal(response.status, 200);
  assert.deepEqual(probe.sentTexts, [RATE_LIMIT_RESPONSE]);
  assert.deepEqual(probe.completedWamids, ['wamid-over-limit']);
  assert.equal(probe.claudeCalls, 0);
  assert.equal(probe.conversationLookups, 0);
});

Deno.test('scopes sender consent per psychologist and sender number', async () => {
  const statements: StubStatement[] = [];
  const client = createSenderConsentsStub(statements);

  assert.equal(await hasSenderConsent('profile-1', '+111', client), false);

  assert.equal(await recordSenderConsent('profile-1', '+111', client), true);
  // Opting in twice is one idempotent upsert against the unique constraint, not two rows.
  assert.equal(await recordSenderConsent('profile-1', '+111', client), true);
  assert.equal(await hasSenderConsent('profile-1', '+111', client), true);

  // Consent is per psychologist: the same number is still unconsented elsewhere.
  assert.equal(await hasSenderConsent('profile-2', '+111', client), false);
  assert.equal(await recordSenderConsent('profile-2', '+111', client), true);
  assert.equal(await hasSenderConsent('profile-1', '+111', client), true);
  assert.equal(await hasSenderConsent('profile-2', '+111', client), true);

  // And per sender: a second number is unconsented for the first psychologist.
  assert.equal(await hasSenderConsent('profile-1', '+222', client), false);

  const upserts = statements.filter((statement) => statement.kind === 'upsert');
  assert.equal(upserts.length, 3);
  // ON CONFLICT needs a real constraint, so the target must be the unique one.
  assert.equal(upserts[0].onConflict, 'psicologo_id,numero_remitente');
  // The payload carries only the conflict target. opted_in_at absent is what stops a
  // repeat opt-in from restating when consent was first given.
  assert.deepEqual(upserts[0].payload, { psicologo_id: 'profile-1', numero_remitente: '+111' });
  assert.equal('opted_in_at' in (upserts[0].payload ?? {}), false);
  assert.equal('origen' in (upserts[0].payload ?? {}), false);
  assert.equal('created_at' in (upserts[0].payload ?? {}), false);
});

Deno.test('fails closed to "no consent" when the consent lookup errors', async () => {
  const client = {
    from() {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: null, error: { code: 'DB_ERROR' } }),
      };
      return query;
    },
  } as unknown as SupabaseClient;

  // A database error must not be read as consent, which would put an unconsented
  // sender straight onto the paid path.
  assert.equal(await hasSenderConsent('profile-1', '+111', client), false);
  assert.equal(await recordSenderConsent('profile-1', '+111', client), false);
});

Deno.test('consumes one rate-limit slot per message in the same window', async () => {
  const statements: StubStatement[] = [];
  const client = createRateBucketStub(statements);
  const windowStart = '2026-03-01T14:00:00.000Z';

  const first = await consumeRateLimitSlot('profile-1', '+111', windowStart, client);
  const second = await consumeRateLimitSlot('profile-1', '+111', windowStart, client);
  // A different window is a different bucket, so it starts from 1 again.
  const nextWindow = await consumeRateLimitSlot('profile-1', '+111', '2026-03-01T15:00:00.000Z', client);

  // Increments, not overwrites: two calls in one window yield 1 then 2.
  assert.equal(first, 1);
  assert.equal(second, 2);
  assert.equal(nextWindow, 1);

  // One round trip per consumed slot. A read followed by a write would be the race the
  // single atomic statement exists to remove.
  assert.equal(statements.length, 3);
  assert.equal(statements.every((statement) => statement.kind === 'upsert'), true);
  assert.equal(statements.every(
    (statement) => statement.rpcFunction === 'consume_sender_rate_limit_slot'
  ), true);
  // The whole primary key is the payload, and nothing else, so the statement cannot
  // touch a column the caller meant to leave alone.
  assert.deepEqual(statements[0].payload, {
    p_psicologo_id: 'profile-1',
    p_numero_remitente: '+111',
    p_window_started_at: windowStart,
  });
  assert.deepEqual(statements[1].payload, statements[0].payload);
});

Deno.test('reports a rate-limit failure as null so the gate can decide which way to fall', async () => {
  const client = {
    rpc: async () => ({ data: null, error: { code: '42883' } }),
  } as unknown as SupabaseClient;

  assert.equal(await consumeRateLimitSlot('profile-1', '+111', '2026-03-01T14:00:00.000Z', client), null);
});

Deno.test('fails open on a rate-limit outage but still gates an unconsented sender', async () => {
  Deno.env.set('META_APP_SECRET', 'test-app-secret');
  // A null count means the counter could not be read. The gate lets the message through
  // rather than denying it, and the consent gate still holds.
  const probe = createGateProbe();
  const response = await handleWebhook(
    await buildWebhookRequest('¿Cuál es el precio?', 'wamid-counter-outage'),
    createWebhookDependencies(probe.overrides(false, null))
  );

  assert.equal(response.status, 200);
  assert.equal(probe.sentTexts.length, 1);
  assert.ok(probe.sentTexts[0].includes(profile.precio));
  assert.ok(probe.sentTexts[0].includes(CONSENT_REQUEST));
  assert.equal(probe.claudeCalls, 0);
  assert.equal(probe.conversationLookups, 0);
});

Deno.test('matches opt-in tokens across case, accents, and repeated whitespace', () => {
  for (const token of ['QUIERO', 'quiero', 'Quiero', 'SÍ', 'sí', 'si', 'ACCEPTO', 'ok', 'De acuerdo', '  DE   ACUERDO  ']) {
    assert.equal(isOptInToken(token), true, `expected ${JSON.stringify(token)} to opt in`);
  }
  // 'hola' must stay an ordinary greeting, and a free-text message that merely contains
  // a token is not consent.
  for (const message of ['', 'Hola', 'quiero saber el precio', 'no quiero', 'deseo']) {
    assert.equal(isOptInToken(message), false, `expected ${JSON.stringify(message)} not to opt in`);
  }
});

Deno.test('keeps routeMessage precedence and serves the greeting for an empty message', async () => {
  // Crisis still wins over scheduling and over a quick admin match.
  const crisisAndScheduling = await routeMessage(
    'quiero agendar una cita porque no quiero vivir',
    profile
  );
  assert.equal(crisisAndScheduling.tipo, 'crisis');
  assert.equal(crisisAndScheduling.contenido, CRISIS_RESPONSE);

  // And the extracted deterministic branch still orders scheduling before clinical
  // before quick admin, which is the order routeMessage delegates to it in.
  assert.equal(routeDeterministicMessage('quiero agendar una cita', profile)?.tipo, 'programacion');
  assert.equal(routeDeterministicMessage('me siento mal', profile)?.tipo, 'clinica');
  assert.equal(routeDeterministicMessage('¿cuánto sale?', profile)?.tipo, 'administrativa');
  // No deterministic match yields null, which is the signal that only Claude can answer,
  // and an empty message is deliberately not handled here.
  assert.equal(routeDeterministicMessage('Hola, ¿me contás sobre vos?', profile), null);
  assert.equal(routeDeterministicMessage('', profile), null);

  // The empty-message short-circuit is unchanged and is served by the exported helper.
  const empty = await routeMessage('', profile);
  assert.equal(empty.contenido, greetingResponse(profile).contenido);
  assert.equal(empty.tipo, 'administrativa');
  // Whitespace-only input sanitizes to empty, so it takes the same branch.
  assert.equal((await routeMessage('   ', profile)).contenido, greetingResponse(profile).contenido);

  // The pre-existing deterministic answers are byte-identical through the refactor.
  assert.equal(
    routeDeterministicMessage('¿Dónde queda?', profile)?.contenido,
    `${profile.nombre} atiende en: ${profile.direccion}.`
  );
});

Deno.test('decides the gate order independently of the webhook', async () => {
  const dependencies = {
    hasSenderConsent: (async () => false) as unknown as WebhookDependencies['hasSenderConsent'],
    recordSenderConsent: (async () => true) as unknown as WebhookDependencies['recordSenderConsent'],
    consumeRateLimitSlot: (async () => 1) as unknown as WebhookDependencies['consumeRateLimitSlot'],
  };

  // 1. Crisis, ahead of an unconsented sender and an over-limit counter.
  assert.deepEqual(
    await evaluateGate('quiero suicidarme', '+111', profile, {
      ...dependencies,
      consumeRateLimitSlot: (async () => 9_999) as unknown as WebhookDependencies['consumeRateLimitSlot'],
    }),
    { outcome: 'allow', reason: 'crisis' }
  );

  // 2. Rate limit, with a distinct ceiling per consent state.
  const overLimit = await evaluateGate('Hola', '+111', profile, {
    ...dependencies,
    consumeRateLimitSlot: (async () => 11) as unknown as WebhookDependencies['consumeRateLimitSlot'],
  });
  assert.deepEqual(overLimit, { outcome: 'rate_limited', response: RATE_LIMIT_RESPONSE });

  // 3. Consented, on the full path. 11 is over the unconsented ceiling but under the
  // consented one, which is the only thing the two ceilings differ on.
  assert.deepEqual(
    await evaluateGate('Hola', '+111', profile, {
      ...dependencies,
      hasSenderConsent: (async () => true) as unknown as WebhookDependencies['hasSenderConsent'],
      consumeRateLimitSlot: (async () => 11) as unknown as WebhookDependencies['consumeRateLimitSlot'],
    }),
    { outcome: 'allow', reason: 'consented' }
  );

  // 4. Opt-in token, and 5. everything else.
  const optIn = await evaluateGate('quiero', '+111', profile, dependencies);
  assert.equal(optIn.outcome, 'optin_confirmed');
  const limited = await evaluateGate('Hola', '+111', profile, dependencies);
  assert.equal(limited.outcome, 'limited');
});
