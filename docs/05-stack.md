# Stack tecnológico

## Decisión de runtime

| Capa | Implementación actual | Uso |
|---|---|---|
| Canal | WhatsApp Business Cloud API de Meta | Inbound y outbound de texto |
| Backend productivo | Supabase Edge Functions sobre Deno 2.1.x; la ejecución Docker verificada usó 2.1.4 | Webhook, procesamiento y acceso a Supabase |
| Compatibilidad local | Node.js 22 y TypeScript en `src/` | Desarrollo y pruebas del árbol local |
| IA | API de Anthropic/Claude Haiku 4.5 | Fallback para consultas administrativas no resueltas localmente |
| Datos | Supabase Postgres | Perfil, conversaciones e idempotencia |
| Agendamiento | Cal.com | Reserva fuera del bot, solo ante solicitud explícita |
| Base de conocimiento | Tabla `psicologos` | Datos estructurados; no RAG ni base de datos vectorial |

## Reparto de responsabilidades

- `supabase/functions/` es la implementación que se despliega en Supabase.
- `supabase/functions/_shared/` contiene la lógica compartida del webhook: HMAC, parsing, routing, persistencia, Claude y envío.
- `src/` es un árbol Node/local de compatibilidad. No debe documentarse como runtime productivo.
- `.github/workflows/tests.yml` verifica Node y Deno; no realiza despliegue.

## Dependencias de infraestructura

El proyecto no documenta garantías de costo, disponibilidad o cumplimiento de planes gratuitos. Meta, Anthropic y Supabase pueden cambiar sus precios, límites y políticas; deben verificarse antes de una decisión comercial.

Google Auth, Cloudflare Pages y un dashboard solo son opciones de Fase 2. No forman parte de la implementación actual.
