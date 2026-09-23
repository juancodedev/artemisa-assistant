// src/services/supabase.ts
// Supabase data access layer
// Provides clean functions for database operations

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

/**
 * Supabase REST API client using fetch.
 * Uses service_role key for admin operations (bypasses RLS).
 */
export const supabase = {
  async getPsicologos(): Promise<any[]> {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/psicologos`, {
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      }
    });
    if (!response.ok) throw new Error(`Failed to fetch psicologos: ${response.status}`);
    return response.json();
  },

  async getPsicologoByWhatsApp(number: string): Promise<any | null> {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/psicologos?numero_whatsapp=eq.${encodeURIComponent(number)}`,
      {
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    if (!response.ok) throw new Error(`Failed to fetch psicologo: ${response.status}`);
    const data = await response.json();
    return data.length > 0 ? data[0] : null;
  },

  async getConversaciones(psicologoId: string): Promise<any[]> {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/conversaciones?psicologo_id=eq.${psicologoId}`,
      {
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    if (!response.ok) throw new Error(`Failed to fetch conversaciones: ${response.status}`);
    return response.json();
  },

  async createConversacion(psicologoId: string, pacienteNumber: string): Promise<any> {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/conversaciones`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        psicologo_id: psicologoId,
        numero_paciente: pacienteNumber,
        historial: [],
        ultima_actividad: new Date().toISOString()
      })
    });
    if (!response.ok) throw new Error(`Failed to create conversacion: ${response.status}`);
    return response.json();
  },

  async updateConversacion(conversacionId: string, historial: any[]): Promise<any> {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/conversaciones?id=eq.${conversacionId}`,
      {
        method: 'PATCH',
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          historial,
          ultima_actividad: new Date().toISOString()
        })
      }
    );
    if (!response.ok) throw new Error(`Failed to update conversacion: ${response.status}`);
    return response.json();
  },

  async appendToHistorial(conversacionId: string, message: { role: string; content: string; timestamp: string }): Promise<any> {
    const conversacion = await this.getConversacionById(conversacionId);
    if (!conversacion) {
      // Create new conversation if it doesn't exist
      return null;
    }
    const updatedHistorial = [...conversacion.historial, message];
    return this.updateConversacion(conversacionId, updatedHistorial);
  },

  async getConversacionById(conversacionId: string): Promise<any | null> {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/conversaciones?id=eq.${conversacionId}`,
      {
        headers: {
          'apikey': SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${SERVICE_ROLE_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );
    if (!response.ok) throw new Error(`Failed to fetch conversacion: ${response.status}`);
    const data = await response.json();
    return data.length > 0 ? data[0] : null;
  }
};
