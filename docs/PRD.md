# PRD — Secretaria virtual para psicólogos

## 1. Decisión de alcance

La **Fase 1 actual** entrega un bot de WhatsApp de texto para un psicólogo demo. El sistema utiliza Supabase Edge Functions sobre Deno, PostgreSQL de Supabase y Anthropic/Claude como fallback. La tabla `psicologos` es la fuente de conocimiento; no existe RAG ni base vectorial.

Google Auth, dashboard, editor de perfil, propiedad por usuario y operación multiusuario están diferidos a Fase 2.

## 2. Usuarios y datos

- **Psicólogo:** usuario principal y futuro pagador. En Fase 1 opera un perfil demo; no tiene cuenta ni dashboard.
- **Paciente:** escribe por WhatsApp y no crea cuenta. Su número normalizado y el historial de conversación se almacenan en Supabase.
- **Operador técnico:** configura el proyecto, aplica migraciones y despliega; no es un usuario de producto.

La Fase 1 no tiene consentimiento digital, exportación, retención ni eliminación de datos. En una interacción de crisis, el texto del paciente no se conserva: se persiste un marcador redactado.

## 3. Leyenda de fases

| Etapa | Estado | Alcance |
|---|---|---|
| **Fase 1** | Actual | Bot de texto, un perfil demo, Supabase Edge Functions y fallback de Claude |
| **Fase 2** | Diferida | Google Auth, dashboard, editor de perfil y ownership RLS |
| **Más adelante** | No implementado | Piloto, canales adicionales, calendario y operación ampliada |

## 4. Objetivo de Fase 1

Responder preguntas administrativas de un consultorio y entregar un link de agenda solo cuando el paciente lo solicita explícitamente. El bot no diagnostica, no prescribe y no sustituye atención profesional.

Criterio de producto:

1. Recibir mensajes de texto de WhatsApp.
2. Validar el webhook de Meta y procesar status events sin respuestas no deseadas del bot.
3. Resolver el perfil demo y conservar contexto acotado.
4. Responder precio, horarios, dirección, modalidad y sistemas de salud desde datos estructurados.
5. Entregar Cal.com solo ante una solicitud explícita de reserva.
6. Rechazar preguntas clínicas y dirigir a atención profesional.
7. Priorizar señales de crisis y entregar únicamente los recursos aprobados.
8. Evitar respuestas duplicadas mediante `wamid` y registrar el resultado de procesamiento.

## 5. Criterios funcionales actuales

| ID | Criterio | Estado |
|---|---|---|
| F1 | HMAC-SHA256 sobre el cuerpo crudo antes de parsear | Implementado |
| F2 | Challenge de Meta y status events | Implementado |
| F3 | Parsing de múltiples mensajes y respuesta agregada | Implementado |
| F4 | Routing por crisis, agenda, clínica, administración y Claude | Implementado |
| F5 | Solo texto | Implementado |
| F6 | Contexto de hasta 20 mensajes | Implementado |
| F7 | Cal.com solo ante solicitud explícita | Implementado |
| F8 | Recursos de crisis aprobados y Claude omitido | Implementado |
| F9 | Persistencia redactada de crisis | Implementado |
| F10 | Idempotencia por `wamid` y estado de entrega incierta | Implementado |

La redacción exacta de crisis, sus palabras clave y las pruebas que protegen el comportamiento son la fuente de verdad en `supabase/functions/_shared/` y `supabase/functions/webhook/index.ts`.

## 6. Arquitectura

```text
Meta webhook
  -> HMAC
  -> parsing de payload
  -> claim de wamid
  -> perfil por meta_phone_number_id
  -> historial acotado
  -> router
  -> Meta Graph API
  -> persistencia y estado idempotente
```

El runtime productivo es `supabase/functions/`. `src/` es un árbol Node/local de compatibilidad y no es la implementación desplegada principal.

## 7. Stack

| Componente | Estado |
|---|---|
| WhatsApp Business Cloud API | Implementado |
| Supabase Postgres | Implementado |
| Supabase Edge Functions + Deno | Implementado |
| Node/TypeScript local | Compatibilidad y CI |
| Anthropic/Claude Haiku 4.5 | Fallback configurado por entorno |
| Cal.com | Link externo para agenda explícita |
| Google Auth / dashboard | Fase 2 |

## 8. Base de datos y seguridad

El esquema efectivo incluye `psicologos`, `conversaciones` y `mensajes_procesados`, con RLS habilitado y permisos de cliente revocados. Las Edge Functions acceden server-side con `service_role`, que bypassa RLS.

La Fase 2 debe agregar ownership por `auth.uid()` y políticas RLS específicas. No se debe exponer la service role ni asumir que RLS por sí solo resuelve autorización cuando el servidor usa un rol privilegiado.

## 9. Privacidad y seguridad operativa

- Número e historial de pacientes se almacenan.
- El texto de crisis se redacta antes de persistirlo.
- No hay consentimiento, retención, eliminación ni exportación.
- La detección de crisis es heurística y no es evaluación clínica.
- No hay canal de notificación al psicólogo.
- `send-message` requiere secreto interno y no es una API pública.
- Los secretos de Meta, Anthropic y Supabase permanecen en el servidor.

## 10. Roadmap

1. **Fase 1 actual:** conservar y validar el bot de texto con perfil demo.
2. **Fase 2:** Google Auth, dashboard, editor de perfil, ownership RLS y eliminación del fallback de fila única.
3. **Más adelante:** piloto, métricas, canales adicionales, calendario propio y evaluación de RAG solo si el modelo estructurado resulta insuficiente.

## 11. Fuera de alcance

No se promete certificación legal, escalamiento clínico, notificación profesional, consentimiento, retención, RAG actual, multimedia ni despliegue automático desde CI. Los costos y límites de los proveedores deben verificarse antes de una decisión comercial.

---

MVP Forge · Álvaro Labs
