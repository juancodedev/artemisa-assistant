# Base de Datos

## Tabla: psicologos
| Campo | Descripción |
|---|---|
| id | identificador único |
| nombre, email, google_id | vienen del login con Google |
| numero_whatsapp | número de WhatsApp Business conectado — así el sistema sabe a qué psicólogo pertenece cada mensaje entrante |
| modalidad | presencial / online / ambas |
| direccion | solo si es presencial |
| precio | |
| tipo_de_cita | |
| sistemas_de_salud | |
| link_calcom | |
| fecha_registro | |

## Tabla: conversaciones
| Campo | Descripción |
|---|---|
| id | identificador único |
| psicologo_id | a qué psicólogo pertenece esta conversación |
| numero_paciente | número de WhatsApp del paciente (dato personal) |
| historial | últimos mensajes intercambiados, para darle contexto a Claude |
| ultima_actividad | para poder limpiar conversaciones viejas |

## Reglas de acceso
- Cada psicólogo solo ve/edita su propia fila en `psicologos` (Row Level Security en Supabase).
- La tabla `conversaciones` solo es accedida por el backend, nunca expuesta directamente al psicólogo ni a terceros.

## Seguridad mínima
- Validación en el servidor, nunca confiar solo en lo que llega desde la pantalla.
- Claves y secretos (WhatsApp, Claude, Supabase) fuera del frontend, solo en el backend.
- Protección contra bots en login: cubierta por el login con Google.

---
MVP Forge · Álvaro Labs
