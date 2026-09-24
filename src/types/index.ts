// src/types/index.ts
// Shared TypeScript types for the bot

export interface Psicologo {
  id: string;
  nombre: string;
  numero_whatsapp: string;
  modalidad: string;
  direccion: string;
  precio: string;
  tipo_de_cita: string;
  sistemas_de_salud: string[];
  link_calcom: string;
  horarios?: string | null;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  updated_at: string;
}

export type TipoConsulta = 'administrativa' | 'clinica' | 'programacion' | 'crisis';

export interface RespuestaBot {
  tipo: TipoConsulta;
  contenido: string;
  // Solo para programación: el link de Cal.com
  link_calcom?: string;
}
