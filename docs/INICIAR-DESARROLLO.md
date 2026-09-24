Vas a ayudarme a construir la Fase 1 del V1 de un proyecto. Aquí está todo el contexto necesario:

## Qué es el proyecto
Un bot de WhatsApp con IA que actúa como "secretaria virtual" de un psicólogo independiente. Responde preguntas administrativas de pacientes (horarios, modalidad de atención, precio, dirección, sistemas de salud) usando datos configurados previamente, y entrega un link de Cal.com cuando el paciente quiere agendar. El bot nunca responde preguntas clínicas o personales — esas las deriva al psicólogo.

## Stack a usar
- **Canal:** WhatsApp Business API (Cloud API de Meta)
- **Motor de IA:** Claude API, modelo Haiku 4.5
- **Base de datos + Backend:** Supabase (Postgres + Edge Functions)
- **Hosting del dashboard (no es parte de esta fase):** Cloudflare Pages

## Alcance de ESTA fase (Fase 1 del roadmap)
Solo construir el bot conversacional funcionando en WhatsApp real, con los datos de UN psicólogo de prueba cargados directamente en la base de datos (sin login ni dashboard todavía — eso es la Fase 2).

No construyas en esta fase: login, dashboard, formulario de configuración, confirmación de pago, ni integración con Instagram. Eso se agrega después.

## Modelo de datos para esta fase

Tabla `psicologos`:
- id, nombre, numero_whatsapp, modalidad, direccion, precio, tipo_de_cita, sistemas_de_salud, link_calcom

Tabla `conversaciones`:
- id, psicologo_id, numero_paciente, historial, ultima_actividad

## Lo que el bot debe hacer (criterios de aceptación)
1. Recibe un mensaje de WhatsApp del paciente (el paciente siempre escribe primero).
2. Busca en la base de datos los datos del psicólogo asociado a ese número de WhatsApp.
3. Usa Claude API para redactar una respuesta natural a la pregunta del paciente, basada solo en esos datos.
4. Si la pregunta es clínica o personal (no administrativa), no la responde — indica que eso se debe conversar directo con el psicólogo.
5. Si el paciente dice explícitamente que quiere agendar/reservar, responde con el link de Cal.com del psicólogo (nunca lo ofrece de forma proactiva antes de que lo pidan).
6. Guarda el historial de la conversación para mantener contexto entre mensajes.

## Seguridad mínima a respetar desde ya
- Las claves de WhatsApp, Claude y Supabase deben vivir en variables de entorno del backend, nunca en código expuesto.
- Toda validación de datos entrantes se hace en el servidor, no se confía en el cliente.

## Cómo quiero que trabajes
Empieza proponiéndome la estructura de carpetas y archivos del proyecto antes de escribir código. Ve paso a paso, y antes de avanzar a la siguiente pieza (por ejemplo, de "recibir el mensaje" a "conectar con Claude"), confírmame que la anterior quedó funcionando.
