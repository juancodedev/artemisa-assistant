// supabase/functions/_shared/supabase.ts
// Server-side Supabase access for the deployed Edge Functions.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Conversacion, MensajeHistoria, Psicologo } from './types.ts';

const INBOUND_MESSAGES_TABLE = 'mensajes_procesados';
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

// The indexed profile lookup can only ever match the single row the partial unique
// index on meta_phone_number_id allows, so one row is the whole answer.
const PROFILE_INDEXED_LOOKUP_LIMIT = 1;
// The fallback needs to distinguish "exactly one profile" from "ambiguous", and two
// rows are enough to prove ambiguity. Anything larger would re-introduce a scan.
const PROFILE_FALLBACK_LOOKUP_LIMIT = 2;
const CONVERSATIONS_TABLE = 'conversaciones';
const CONVERSATION_CONFLICT_TARGET = 'psicologo_id,numero_paciente';
const SENDER_CONSENTS_TABLE = 'sender_consents';
const RATE_BUCKETS_TABLE = 'sender_rate_buckets';
// Both conflict targets below must match a real constraint, not a bare index, so
// PostgREST can build the ON CONFLICT clause. Migration 006 guarantees both.
const SENDER_CONSENT_CONFLICT_TARGET = 'psicologo_id,numero_remitente';
// Name of the atomic increment function created by migration 006.
const RATE_LIMIT_SLOT_FUNCTION = 'consume_sender_rate_limit_slot';

type ProfileRow = Partial<Psicologo> & { id: string };

export function selectPsicologoFromRows(
  rows: unknown,
  phoneNumberId?: string
): Psicologo | null {
  if (!Array.isArray(rows)) return null;
  const profiles = rows.filter(
    (row): row is ProfileRow =>
      !!row && typeof row === 'object' && typeof (row as { id?: unknown }).id === 'string'
  );
  if (phoneNumberId) {
    const matchingProfile = profiles.find(
      (profile) => profile.meta_phone_number_id === phoneNumberId
    );
    if (matchingProfile) return matchingProfile as Psicologo;
  }

  if (profiles.length === 1) return profiles[0] as Psicologo;
  return null;
}

let clientInstance: SupabaseClient | null = null;

function getEnv(name: string): string {
  try {
    return Deno.env.get(name) || '';
  } catch {
    return '';
  }
}

export function getSupabaseClient(): SupabaseClient {
  if (clientInstance) return clientInstance;

  const supabaseUrl = getEnv('SUPABASE_URL');
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('Supabase service configuration is missing');
  }

  clientInstance = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
  return clientInstance;
}

/**
 * Resolve a psychologist by Meta phone-number ID.
 *
 * The filtered lookup on `meta_phone_number_id` is the only reason the partial
 * unique index from migration 004 exists, so it runs first and never scans the
 * whole table.
 *
 * The sole-row fallback is an explicit Phase 1 compatibility behavior only. It is
 * served by a bounded fallback query capped at two rows: one row means the
 * single-profile installation and resolves, two rows prove ambiguity and resolve
 * to null. It is therefore never used when the database contains more than one
 * profile, exactly as before.
 */
export async function getPsicologo(
  phoneNumberId?: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<Psicologo | null> {
  try {
    if (phoneNumberId) {
      const { data, error } = await client
        .from('psicologos')
        .select('*')
        .eq('meta_phone_number_id', phoneNumberId)
        .limit(PROFILE_INDEXED_LOOKUP_LIMIT);

      if (error) {
        console.error('Error loading psychologist profile by phone number id');
        return null;
      }

      const indexedMatch = selectPsicologoFromRows(data, phoneNumberId);
      if (indexedMatch) return indexedMatch;
    }

    const { data, error } = await client
      .from('psicologos')
      .select('*')
      .limit(PROFILE_FALLBACK_LOOKUP_LIMIT);

    if (error) {
      console.error('Error loading psychologist profiles');
      return null;
    }
    return selectPsicologoFromRows(data, phoneNumberId);
  } catch {
    console.error('Exception resolving psychologist profile');
    return null;
  }
}

export async function getPsicologoByMetaPhoneNumberId(
  phoneNumberId: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<Psicologo | null> {
  return getPsicologo(phoneNumberId, client);
}

export function getBoundedHistory(
  history: unknown,
  maxMessages = 20
): MensajeHistoria[] {
  if (!Array.isArray(history) || maxMessages <= 0) return [];

  return history
    .filter((item): item is Record<string, unknown> => {
      return (
        !!item &&
        typeof item === 'object' &&
        (item.role === 'user' || item.role === 'assistant') &&
        typeof item.content === 'string' &&
        typeof item.timestamp === 'string'
      );
    })
    .slice(-maxMessages)
    .map((item) => ({
      role: item.role as 'user' | 'assistant',
      content: (item.content as string).trim().slice(0, 2000),
      timestamp: item.timestamp as string,
    }))
    .filter((item) => item.content.length > 0);
}

/**
 * Claim a Meta wamid for processing.
 * Completed and delivery-uncertain events are non-repeating; failed and stale processing events can be retried.
 */
export async function claimIncomingMessage(
  wamid: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<'claimed' | 'duplicate' | 'busy' | 'uncertain'> {
  const startedAt = new Date().toISOString();
  const { error: insertError } = await client
    .from(INBOUND_MESSAGES_TABLE)
    .insert({
      wamid,
      status: 'processing',
      processing_started_at: startedAt,
      created_at: startedAt,
      updated_at: startedAt,
    });

  if (!insertError) return 'claimed';

  if (insertError.code !== '23505') {
    console.error('Unable to claim inbound message');
    return 'uncertain';
  }

  const { data: existing, error: selectError } = await client
    .from(INBOUND_MESSAGES_TABLE)
    .select('wamid, status, processing_started_at')
    .eq('wamid', wamid)
    .maybeSingle();

  if (selectError || !existing) {
    if (selectError) console.error('Unable to inspect inbound message state');
    return 'uncertain';
  }

  if (existing.status === 'completed' || existing.status === 'delivery_uncertain') {
    return 'duplicate';
  }

  const isFailed = existing.status === 'failed';
  const isStale =
    existing.status === 'processing' &&
    typeof existing.processing_started_at === 'string' &&
    Date.parse(existing.processing_started_at) < Date.now() - PROCESSING_LEASE_MS;

  if (!isFailed && !isStale) return 'busy';

  let reclaimQuery = client
    .from(INBOUND_MESSAGES_TABLE)
    .update({
      status: 'processing',
      processing_started_at: startedAt,
      updated_at: startedAt,
      error_code: null,
    })
    .eq('wamid', wamid)
    .eq('status', existing.status);

  if (isStale && typeof existing.processing_started_at === 'string') {
    // Compare the observed lease value so only one worker can reclaim this stale row.
    reclaimQuery = reclaimQuery.eq(
      'processing_started_at',
      existing.processing_started_at
    );
  }

  const { data: reclaimed, error: updateError } = await reclaimQuery
    .select('wamid')
    .maybeSingle();

  if (updateError) {
    console.error('Unable to reclaim failed inbound message');
    return 'uncertain';
  }

  if (!reclaimed) {
    // A concurrent worker won the compare-and-swap; do not acknowledge it as duplicate.
    const { error: recheckError } = await client
      .from(INBOUND_MESSAGES_TABLE)
      .select('wamid, status')
      .eq('wamid', wamid)
      .maybeSingle();
    if (recheckError) console.error('Unable to recheck inbound message after reclaim');
    return 'busy';
  }

  return 'claimed';
}

export async function completeIncomingMessage(
  wamid: string,
  clientOrErrorCode: 'persistence_failed' | null | SupabaseClient = null,
  defaultClient: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  const client =
    clientOrErrorCode && typeof clientOrErrorCode === 'object'
      ? clientOrErrorCode
      : defaultClient;
  const errorCode = clientOrErrorCode === 'persistence_failed' ? clientOrErrorCode : null;
  const now = new Date().toISOString();
  const { data, error } = await client
    .from(INBOUND_MESSAGES_TABLE)
    .update({
      status: 'completed',
      error_code: errorCode,
      processed_at: now,
      processing_started_at: null,
      updated_at: now,
    })
    .eq('wamid', wamid)
    .eq('status', 'processing')
    .select('wamid')
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('Unable to complete inbound message state');
    return false;
  }
  return true;
}

/**
 * Persist an accepted-but-unconfirmed delivery without automatic Meta retry.
 * The operator can repair this event later using the redacted error code.
 */
export async function markDeliveryUncertain(
  wamid: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from(INBOUND_MESSAGES_TABLE)
    .update({
      status: 'delivery_uncertain',
      error_code: 'delivery_uncertain',
      processed_at: now,
      processing_started_at: null,
      updated_at: now,
    })
    .eq('wamid', wamid)
    .eq('status', 'processing')
    .select('wamid')
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('Unable to persist uncertain delivery state');
    return false;
  }
  return true;
}

export async function failIncomingMessage(
  wamid: string,
  errorCode: 'delivery_failed' | 'processing_failed',
  client: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  const now = new Date().toISOString();
  const { data, error } = await client
    .from(INBOUND_MESSAGES_TABLE)
    .update({
      status: 'failed',
      error_code: errorCode,
      processing_started_at: null,
      updated_at: now,
    })
    .eq('wamid', wamid)
    .eq('status', 'processing')
    .select('wamid')
    .maybeSingle();

  if (error || !data) {
    if (error) console.error('Unable to mark inbound message as failed');
    return false;
  }
  return true;
}

/**
 * Get or create an existing conversation for a patient and psychologist.
 *
 * Resolution is a single atomic statement, so concurrent deliveries of the same
 * inbound message cannot split the patient history across duplicate rows the way
 * the previous maybeSingle() read followed by a separate insert() did.
 *
 * The payload deliberately carries only the conflict target plus `ultima_actividad`.
 * PostgREST builds the `ON CONFLICT ... DO UPDATE SET` clause exclusively from the
 * columns present in the payload, so omitting `historial` and `created_at` means the
 * duplicate path cannot overwrite an existing history or creation time, while the
 * insert path still receives the column defaults (`'[]'` and `now()`).
 *
 * This depends on the unique constraint added in migration 005, so that migration
 * must be applied before this code is deployed.
 */
export async function getOrCreateConversacion(
  psicologoId: string,
  patientNumber: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<Conversacion | null> {
  try {
    const { data, error } = await client
      .from(CONVERSATIONS_TABLE)
      .upsert(
        {
          psicologo_id: psicologoId,
          numero_paciente: patientNumber,
          ultima_actividad: new Date().toISOString(),
        },
        { onConflict: CONVERSATION_CONFLICT_TARGET }
      )
      .select('*')
      .single();

    if (error || !data) {
      console.error('Error resolving conversation');
      return null;
    }
    return data as Conversacion;
  } catch {
    console.error('Exception in getOrCreateConversacion');
    return null;
  }
}

/**
 * Append messages to a conversation history using the latest server-side snapshot.
 */
export async function appendMessagesToConversacion(
  conversacionId: string,
  currentHistory: MensajeHistoria[],
  newMessages: MensajeHistoria[],
  client: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  try {
    const updatedHistory = [...(currentHistory || []), ...newMessages];
    const { error } = await client
      .from('conversaciones')
      .update({
        historial: updatedHistory,
        ultima_actividad: new Date().toISOString(),
      })
      .eq('id', conversacionId);

    if (error) {
      console.error('Error updating conversation history');
      return false;
    }
    return true;
  } catch {
    console.error('Exception in appendMessagesToConversacion');
    return false;
  }
}

/**
 * Whether a sender has explicitly opted in for this psychologist.
 *
 * Consent is scoped per (psicologo_id, numero_remitente), so a sender who opted in
 * with one professional is still unconsented for another. The lookup is an equality
 * match on the unique constraint declared by migration 006, so it is an index probe
 * rather than a scan.
 *
 * Never throws. A query failure reports "not consented" instead of throwing, because
 * the caller's response to that answer is the safe path: an unconsented sender gets a
 * deterministic answer and no Claude call, whereas treating a database error as
 * consent would put an unconsented stranger on the paid path.
 */
export async function hasSenderConsent(
  psicologoId: string,
  senderNumber: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  try {
    const { data, error } = await client
      .from(SENDER_CONSENTS_TABLE)
      .select('numero_remitente')
      .eq('psicologo_id', psicologoId)
      .eq('numero_remitente', senderNumber)
      .maybeSingle();

    if (error) {
      console.error('Error loading sender consent');
      return false;
    }
    return !!data;
  } catch {
    console.error('Exception loading sender consent');
    return false;
  }
}

/**
 * Record a sender's opt-in consent. Idempotent: re-sending an opt-in token resolves
 * to the same row.
 *
 * The payload deliberately carries only the conflict target. PostgREST builds the
 * `ON CONFLICT ... DO UPDATE SET` clause exclusively from the columns present in the
 * payload, so omitting `opted_in_at` means a repeat opt-in cannot restate when consent
 * was first given, and omitting `origen` and `created_at` means the conflict path
 * cannot clobber how consent was captured or when the row was created. The insert
 * path still receives the column defaults.
 *
 * Never throws; a failed write reports false so the caller can decide what to tell the
 * sender instead of claiming a consent that was not stored.
 */
export async function recordSenderConsent(
  psicologoId: string,
  senderNumber: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<boolean> {
  try {
    const { data, error } = await client
      .from(SENDER_CONSENTS_TABLE)
      .upsert(
        {
          psicologo_id: psicologoId,
          numero_remitente: senderNumber,
        },
        { onConflict: SENDER_CONSENT_CONFLICT_TARGET }
      )
      .select('numero_remitente')
      .maybeSingle();

    if (error || !data) {
      console.error('Error recording sender consent');
      return false;
    }
    return true;
  } catch {
    console.error('Exception in recordSenderConsent');
    return false;
  }
}

/**
 * Consume one rate-limit slot for a sender window and return the resulting count.
 *
 * The counter update is a single `INSERT ... ON CONFLICT ... DO UPDATE ... RETURNING`
 * statement executed by `consume_sender_rate_limit_slot` from migration 006, so the
 * increment happens inside Postgres under the row lock the conflict takes. Two
 * concurrent webhooks for the same sender and window therefore serialize instead of
 * both reading the same pre-increment value, and neither can consume the same slot.
 *
 * It is a function rather than a PostgREST `.upsert()` because PostgREST builds
 * `DO UPDATE SET` only from the payload columns and has no arithmetic form, so a
 * payload of `{ message_count: 1 }` would blind-set the counter back to 1 on every
 * call and the ceiling could never be reached. Migration 006 must be applied before
 * this is deployed, exactly as migration 005 must precede getOrCreateConversacion.
 *
 * Returns `null` on error so the caller chooses explicitly rather than inheriting a
 * silent default. `gate.ts` chooses to FAIL OPEN: the rate limit is a volume brake,
 * not the cost control that matters, because the path it protects for a non-consented
 * sender makes no Claude call and writes no history at all. Failing open on a counter
 * error can therefore cost a handful of extra deterministic answers, whereas failing
 * closed would deny service to an already-consented patient during a transient
 * database blip. A `null` count must still never be read as "below the ceiling" for
 * any caller that does gate paid work.
 */
export async function consumeRateLimitSlot(
  psicologoId: string,
  senderNumber: string,
  windowStartedAt: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<number | null> {
  try {
    const { data, error } = await client.rpc(RATE_LIMIT_SLOT_FUNCTION, {
      p_psicologo_id: psicologoId,
      p_numero_remitente: senderNumber,
      p_window_started_at: windowStartedAt,
    });

    if (error || typeof data !== 'number') {
      console.error('Error consuming rate limit slot');
      return null;
    }
    return data;
  } catch {
    console.error('Exception in consumeRateLimitSlot');
    return null;
  }
}
