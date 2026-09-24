// supabase/functions/_shared/supabase.ts
// Server-side Supabase access for the deployed Edge Functions.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Conversacion, MensajeHistoria, Psicologo } from './types.ts';

const INBOUND_MESSAGES_TABLE = 'mensajes_procesados';
const PROCESSING_LEASE_MS = 5 * 60 * 1000;

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
 * The sole-row fallback is an explicit Phase 1 compatibility behavior only. It
 * is never used when the database contains more than one profile.
 */
export async function getPsicologo(
  phoneNumberId?: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<Psicologo | null> {
  try {
    const { data, error } = await client.from('psicologos').select('*');
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
 */
export async function getOrCreateConversacion(
  psicologoId: string,
  patientNumber: string,
  client: SupabaseClient = getSupabaseClient()
): Promise<Conversacion | null> {
  try {
    const { data, error } = await client
      .from('conversaciones')
      .select('*')
      .eq('psicologo_id', psicologoId)
      .eq('numero_paciente', patientNumber)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      console.error('Error fetching conversation');
      return null;
    }
    if (data) return data as Conversacion;

    const { data: newConversation, error: insertError } = await client
      .from('conversaciones')
      .insert({
        psicologo_id: psicologoId,
        numero_paciente: patientNumber,
        historial: [],
        ultima_actividad: new Date().toISOString(),
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating conversation');
      return null;
    }
    return newConversation as Conversacion;
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
