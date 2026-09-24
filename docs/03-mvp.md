# MVP — Estado actual

## Fase 1 implementada

El MVP actual es un bot de WhatsApp de texto para un solo psicólogo demo. No incluye login, dashboard ni configuración visual.

| Capacidad | Estado actual |
|---|---|
| Entrada por WhatsApp Business Cloud API | Implementada |
| Verificación HMAC del cuerpo crudo | Implementada |
| Parsing de múltiples mensajes y status events | Implementada |
| Perfil demo único | Implementada |
| Respuestas administrativas desde `psicologos` | Implementada |
| Agendamiento explícito con Cal.com | Implementada |
| Rechazo de consultas clínicas | Implementado |
| Prioridad de crisis y recursos aprobados | Implementada |
| Historial de conversación | Implementado, limitado a 20 mensajes para IA |
| Idempotencia por `wamid` | Implementada |
| Tests y typecheck en CI | Implementados |

## Criterio de cierre de la Fase 1

- [x] Un perfil ficticio de demostración disponible desde `supabase/seed/001_test_psicologo.sql`.
- [x] Webhook productivo en Supabase Edge Functions con validación HMAC.
- [x] Respuestas administrativas locales y fallback de Claude.
- [x] Link de Cal.com solo ante una solicitud explícita.
- [x] Crisis antes de cualquier otra ruta, sin llamada a Claude.
- [x] Persistencia redactada para crisis.
- [x] Idempotencia y estado de entrega incierta registrados en Supabase.
- [x] Pruebas Node y Deno ejecutadas por CI.

## Fase 2

- Google Auth para psicólogos.
- Dashboard y editor del perfil.
- Propiedad por usuario y políticas RLS de ownership.
- Gestión de múltiples números de WhatsApp sin fallback de perfil único.
- Flujo operativo para consentimiento, retención y eliminación de datos.

## Más adelante

- Piloto con más profesionales y métricas validadas.
- Calendario propio, recordatorios y canales adicionales.
- Operación de incidentes de entrega incierta.
- Evaluación de conocimiento RAG solo si el modelo de datos de `psicologos` deja de ser suficiente.

## Límites del MVP

La solución actual no ofrece garantía clínica, certificación legal, consentimiento ni retención, canal de notificación profesional, análisis semántico de crisis, RAG ni soporte de audio, imágenes o documentos. El paciente siempre escribe primero y el MVP procesa únicamente texto.
