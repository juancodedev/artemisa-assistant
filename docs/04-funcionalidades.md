# Funcionalidades de la Fase 1

## Criterios implementados

| Capacidad | Criterio de aceptación actual |
|---|---|
| Verificación del webhook | Todo POST se valida mediante HMAC-SHA256 sobre el cuerpo crudo. Una firma ausente, inválida o un secreto no configurado producen rechazo antes de procesar el payload. |
| Verificación del challenge | El GET de Meta solo devuelve el challenge cuando `hub.mode`, `hub.verify_token` y el secreto configurado coinciden; falla cerrado si falta configuración. |
| Status events | Los payloads sin mensajes entrantes, incluidos los que contienen estados de entrega, se reconocen y responden HTTP 200 sin invocar al bot. |
| Multi-message parsing | Se recorren todas las combinaciones de `entry`, `change` y `messages` antes de decidir la respuesta HTTP del lote. |
| Solo texto | Los mensajes sin texto válido reciben una respuesta informativa. No se procesan audios, imágenes ni documentos. |
| Perfil demo | El webhook selecciona el perfil por `meta_phone_number_id`. El fallback a una única fila es exclusivo de la Fase 1 y se deshabilita si existen varias filas sin coincidencia. |
| Historial acotado | Claude recibe como máximo los 20 mensajes históricos más recientes; cada mensaje se limita a 2.000 caracteres. |
| Idempotencia | El `wamid` se reclama en `mensajes_procesados` antes de procesar. Eventos completados o con entrega incierta se consideran no repetibles; fallos y leases vencidos pueden reclamarse. |
| Agendamiento | El link de Cal.com se entrega únicamente ante una solicitud explícita de agendar o reservar. Las respuestas administrativas sobre horarios no reciben el link. |
| Protección de Claude | Las respuestas generadas que no corresponden a una solicitud explícita de agenda eliminan links de Cal.com antes de enviarse. |
| Entrega incierta | Un timeout, error de red o respuesta 2xx sin ID de mensaje se registra como `delivery_uncertain`; no se reenvía automáticamente para evitar duplicados. |
| Lote | El webhook procesa todos los mensajes del payload y agrega los resultados antes de responder. Fallos reintentables o mensajes ocupados producen HTTP 502. |

## Orden de routing

1. **Crisis:** prioridad absoluta; no llama a Claude.
2. **Agendamiento explícito:** respuesta local con el link de Cal.com del perfil.
3. **Consulta clínica/personal:** rechazo que indica que requiere atención directa del profesional.
4. **Administrativa conocida:** respuesta local para precio, horarios, dirección, modalidad y sistemas de salud.
5. **Fallback:** Claude con el perfil y el historial acotado; si no está disponible, usa una respuesta administrativa segura.

## Crisis

- Detecta señales heurísticas de suicidio o autolesión en el texto normalizado.
- Entrega los dos recursos aprobados: `*4141` y Salud Responde `600 360 7777`, opción 2.
- Declara que la conversación no reemplaza la atención profesional.
- No incluye Cal.com, no incluye `133` y no promete que se notificará al psicólogo.
- Almacena un marcador redactado en lugar del texto crudo.

El texto exacto, las palabras clave y las aserciones de seguridad se definen en `supabase/functions/_shared/validation.ts`, `supabase/functions/_shared/router.ts`, `supabase/functions/webhook/index.ts` y `supabase/functions/_shared/phase1.test.ts`; esos archivos y pruebas son la fuente de verdad.

## Privacidad y operación

- `conversaciones` almacena número de paciente e historial.
- La ruta de crisis redacta el texto del paciente antes de persistirlo.
- No existe flujo de consentimiento, retención o eliminación.
- La detección de crisis es heurística y no constituye evaluación clínica.
- El acceso de la aplicación usa `service_role` desde el servidor y bypassa RLS.
- La función `send-message` exige el secreto interno y rechaza solicitudes públicas.

## Fuera de la Fase 1

Google Auth, dashboard, editor de perfil, ownership RLS, notificaciones clínicas, multimedia, RAG y panel operativo no forman parte de los criterios implementados actuales.
