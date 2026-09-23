// supabase/functions/_shared/supabase.ts
// Supabase Database helper using the official @supabase/supabase-js client

import { createClient } from '@supabase/supabase-js';
import { Psicologo, Conversacion, MensajeHistoria } from './types.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

export const supabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

/**
 * Fetch psychologist by WhatsApp number or fallback to the first psychologist in Phase 1.
 */
export async function getPsicologo(whatsappNumber?: string): Promise<Psicologo | null> {
  try {
    let query = supabaseClient.from('psicologos').select('*');
    if (whatsappNumber) {
      const cleanNumber = whatsappNumber.replace(/[^\d+]/g, '');
      query = query.or(`numero_whatsapp.eq.${cleanNumber},numero_whatsapp.eq.+${cleanNumber.replace(/^\+/, '')}`);
    }

    const { data, error } = await query.limit(1).maybeSingle();
    if (error) {
      console.error('Error fetching psicologo:', error);
      return null;
    }
    return (data as Psicologo) || null;
  } catch (err) {
    console.error('Exception fetching psicologo:', err);
    return null;
  }
}

/**
 * Get or create an existing conversation for a patient and psychologist.
 */
export async function getOrCreateConversacion(
  psicologoId: string,
  patientNumber: string
): Promise<Conversacion | null> {
  try {
    const { data, error } = await supabaseClient
      .from('conversaciones')
      .select('*')
      .eq('psicologo_id', psicologoId)
      .eq('numero_paciente', patientNumber)
      .maybeSingle();

    if (error) {
      console.error('Error fetching conversacion:', error);
      return null;
    }

    if (data) {
      return data as Conversacion;
    }

    // Create new conversation
    const { data: newConv, error: insertError } = await supabaseClient
      .from('conversaciones')
      .insert({
        psicologo_id: psicologoId,
        numero_paciente: patientNumber,
        historial: [],
        ultima_actividad: new Date().toISOString()
      })
      .select()
      .single();

    if (insertError) {
      console.error('Error creating conversacion:', insertError);
      return null;
    }

    return newConv as Conversacion;
  } catch (err) {
    console.error('Exception in getOrCreateConversacion:', err);
    return null;
  }
}

/**
 * Append messages to a conversation history.
 */
export async function appendMessagesToConversacion(
  conversacionId: string,
  currentHistory: MensajeHistoria[],
  newMessages: MensajeHistoria[]
): Promise<boolean> {
  try {
    const updatedHistory = [...(currentHistory || []), ...newMessages];
    const { error } = await supabaseClient
      .from('conversaciones')
      .update({
        historial: updatedHistory,
        ultima_actividad: new Date().toISOString()
      })
      .eq('id', conversacionId);

    if (error) {
      console.error('Error updating conversacion historial:', error);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Exception in appendMessagesToConversacion:', err);
    return false;
  }
}
