// supabase/functions/_shared/types.ts
// Shared TypeScript types for the deployed Artemisa Assistant runtime.

export interface Psicologo {
  id: string;
  nombre: string;
  numero_whatsapp: string;
  meta_phone_number_id?: string | null;
  modalidad: string;
  direccion: string;
  precio: string;
  tipo_de_cita: string;
  sistemas_de_salud: string[];
  link_calcom: string;
  horarios?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface MensajeHistoria {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface Conversacion {
  id: string;
  psicologo_id: string;
  numero_paciente: string;
  historial: MensajeHistoria[];
  ultima_actividad: string;
  created_at?: string;
  updated_at?: string;
}

export type TipoConsulta = 'administrativa' | 'clinica' | 'programacion' | 'crisis';

export interface RespuestaBot {
  tipo: TipoConsulta;
  contenido: string;
  link_calcom?: string;
}
