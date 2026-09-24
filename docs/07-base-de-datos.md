# Base de datos

## Estado efectivo después de las migraciones 001–004

La migración 004 es parte del esquema efectivo: deja RLS habilitado, revoca los permisos de cliente y elimina las políticas públicas de las migraciones anteriores. La Fase 1 accede a las tablas desde Edge Functions mediante `service_role`.

## `psicologos`

| Campo | Tipo efectivo | Uso |
|---|---|---|
| `id` | `uuid` | Identificador interno |
| `nombre` | `text not null` | Nombre del profesional |
| `numero_whatsapp` | `text not null unique` | Identificador de contacto del perfil |
| `meta_phone_number_id` | `text null` | Identificador del número de WhatsApp de Meta |
| `modalidad` | `text not null` | Modalidad de atención |
| `direccion` | `text not null` | Dirección del consultorio |
| `precio` | `text not null` | Texto de honorarios |
| `tipo_de_cita` | `text not null` | Tipo de sesión |
| `sistemas_de_salud` | `text[] not null` | Sistemas aceptados |
| `link_calcom` | `text not null` | Link de agenda |
| `horarios` | `text null` | Disponibilidad en texto |
| `created_at` | `timestamptz` | Fecha de creación |
| `updated_at` | `timestamptz` | Fecha de última actualización |

`meta_phone_number_id` es nullable, pero tiene un índice único parcial para los valores presentes. El webhook busca coincidencia exacta por este campo. El fallback a la única fila existente es una compatibilidad exclusiva de la Fase 1.

La fuente activa de datos demo es `supabase/seed/001_test_psicologo.sql`. `supabase/migrations/003_seed_test_psicologo.sql` es una migración histórica ya aplicada y contiene datos anteriores; no debe usarse como fuente actual de configuración.

## `conversaciones`

| Campo | Tipo efectivo | Uso |
|---|---|---|
| `id` | `uuid` | Identificador de conversación |
| `psicologo_id` | `uuid not null` | Referencia a `psicologos.id` |
| `numero_paciente` | `text not null` | Número de WhatsApp del paciente |
| `historial` | `jsonb not null` | Mensajes de usuario y asistente |
| `ultima_actividad` | `timestamptz` | Última actualización |
| `created_at` | `timestamptz` | Fecha de creación |
| `updated_at` | `timestamptz` | Fecha de última actualización |

El número del paciente y el historial sí se almacenan. Cuando Claude procesa una conversación, solo recibe los 20 mensajes históricos más recientes, con un máximo de 2.000 caracteres por mensaje. En una interacción de crisis se persiste un marcador redactado en lugar del texto de entrada.

## `mensajes_procesados`

| Campo | Tipo efectivo | Uso |
|---|---|---|
| `wamid` | `text primary key` | Identificador de idempotencia de Meta |
| `status` | `text not null` | `processing`, `completed`, `failed` o `delivery_uncertain` |
| `processing_started_at` | `timestamptz` | Inicio del lease de procesamiento |
| `processed_at` | `timestamptz` | Fin registrado |
| `error_code` | `text` | Causa resumida del fallo o estado incierto |
| `created_at` | `timestamptz` | Fecha de creación |
| `updated_at` | `timestamptz` | Fecha de actualización |

Existe un índice por `status` y `processing_started_at`. La tabla registra el estado durable de cada `wamid`; no sustituye una bandeja operativa para resolver entregas inciertas.

## Acceso y RLS

- Las tres tablas tienen RLS habilitado.
- La migración 004 revoca todos los privilegios de `public`, `anon` y `authenticated` sobre las tablas.
- Las políticas públicas de las migraciones 001 y 002 se eliminan.
- `webhook` y el acceso de datos en `supabase/functions/_shared/supabase.ts` usan `SUPABASE_SERVICE_ROLE_KEY` desde el servidor.
- El rol `service_role` bypassa RLS; la clave no debe llegar a un cliente público.
- `send-message` es una función interna protegida por secreto, no un acceso de base de datos para terceros.

## Privacidad y trabajo futuro

La Fase 1 no implementa consentimiento, retención, exportación ni eliminación. Tampoco hay Google Auth ni propiedad por usuario. La Fase 2 debe agregar políticas RLS que vinculen `psicologos` con su propietario y defina acceso autorizado a `conversaciones`; no se debe habilitar un acceso directo de cliente como sustituto de esa capa.
