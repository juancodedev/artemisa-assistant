// src/services/supabase.ts
// Supabase data access layer

import { createClient } from '@supabase/supabase-js';

function getEnv(key: string): string {
  if (typeof Deno !== 'undefined' && Deno.env) {
    return Deno.env.get(key) || '';
  }
  return process.env[key] || '';
}

const SUPABASE_URL = getEnv('SUPABASE_URL');
const SERVICE_ROLE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');

export const supabaseJs = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false
  }
});

export const supabase = {
  async getPsicologos(): Promise<any[]> {
    const { data, error } = await supabaseJs.from('psicologos').select('*');
    if (error) throw error;
    return data || [];
  },

  async getPsicologoByWhatsApp(number: string): Promise<any | null> {
    const cleanNumber = number.replace(/[^\d+]/g, '');
    const { data, error } = await supabaseJs
      .from('psicologos')
      .select('*')
      .or(`numero_whatsapp.eq.${cleanNumber},numero_whatsapp.eq.+${cleanNumber.replace(/^\+/, '')}`)
      .limit(1)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },

  async getConversaciones(psicologoId: string): Promise<any[]> {
    const { data, error } = await supabaseJs
      .from('conversaciones')
      .select('*')
      .eq('psicologo_id', psicologoId);

    if (error) throw error;
    return data || [];
  },

  async createConversacion(psicologoId: string, pacienteNumber: string): Promise<any> {
    const { data, error } = await supabaseJs
      .from('conversaciones')
      .insert({
        psicologo_id: psicologoId,
        numero_paciente: pacienteNumber,
        historial: [],
        ultima_actividad: new Date().toISOString()
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async updateConversacion(conversacionId: string, historial: any[]): Promise<any> {
    const { data, error } = await supabaseJs
      .from('conversaciones')
      .update({
        historial,
        ultima_actividad: new Date().toISOString()
      })
      .eq('id', conversacionId)
      .select()
      .single();

    if (error) throw error;
    return data;
  },

  async appendToHistorial(
    conversacionId: string,
    message: { role: string; content: string; timestamp: string }
  ): Promise<any> {
    const conversacion = await this.getConversacionById(conversacionId);
    if (!conversacion) return null;
    const updatedHistorial = [...(conversacion.historial || []), message];
    return this.updateConversacion(conversacionId, updatedHistorial);
  },

  async getConversacionById(conversacionId: string): Promise<any | null> {
    const { data, error } = await supabaseJs
      .from('conversaciones')
      .select('*')
      .eq('id', conversacionId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }
};
