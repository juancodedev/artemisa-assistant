# Arquitectura

## Flujo productivo de WhatsApp

```text
Meta
  -> webhook de Supabase Edge Function
  -> HMAC-SHA256 sobre el cuerpo crudo
  -> parsing de todos los mensajes y status events
  -> claim por wamid en mensajes_procesados
  -> perfil por meta_phone_number_id
  -> conversación e historial acotado a 20 mensajes
  -> router de crisis / agenda / clínica / administración / Claude
  -> cliente Meta Graph API
  -> persistencia del intercambio
  -> estado final completed / failed / delivery_uncertain
```

## Pasos del webhook

1. **Entrada y tamaño.** Solo se acepta GET para el challenge y POST para eventos. El cuerpo POST tiene un límite de 1 MB.
2. **Autenticidad de Meta.** Se calcula HMAC-SHA256 sobre el texto crudo exacto y se compara con `X-Hub-Signature-256` en tiempo constante. La falta de firma o secreto falla cerrada.
3. **Parsing.** Se recorren todos los `entry`, `change` y `messages`. Los status events se reconocen y no activan el bot.
4. **Idempotencia.** Antes de obtener contexto se intenta insertar el `wamid` en `mensajes_procesados`. La clave primaria evita procesar el mismo evento dos veces. Estados `completed` y `delivery_uncertain` son no repetibles; `failed` y un `processing` vencido pueden recuperarse.
5. **Perfil.** Se busca el psicólogo por `metadata.phone_number_id`. Para la Fase 1 se permite el fallback únicamente cuando existe una sola fila. Con varias filas sin coincidencia no se selecciona un perfil.
6. **Conversación.** Se obtiene o crea el registro por `psicologo_id` y número normalizado. El contexto para Claude se limita a los 20 mensajes más recientes y 2.000 caracteres por mensaje.
7. **Routing.** La primera señal de crisis tiene prioridad. Después se evalúan solicitud explícita de agenda, consulta clínica, respuesta administrativa local y fallback de Claude.
8. **Outbound.** El cliente compartido usa Meta Graph API, valida el ID de mensaje devuelto y distingue entre fallo definitivo y entrega incierta.
9. **Persistencia e idempotencia.** Tras un envío confirmado se guardan usuario y respuesta, salvo crisis, donde el usuario se sustituye por un marcador redactado. Luego el `wamid` pasa a `completed`.

## Orden de routing

```text
crisis
  -> agenda explícita
  -> consulta clínica
  -> respuesta administrativa local
  -> Claude
```

### Crisis

- Se procesa antes de todas las demás rutas y nunca llama a Claude.
- Entrega `*4141` y Salud Responde `600 360 7777`, opción 2.
- Indica que se requiere atención profesional.
- No contiene Cal.com ni `133` y no promete notificación al psicólogo.
- Persiste un marcador redactado, no el texto original.
- Usa detección heurística por palabras clave.

### Agenda explícita

La solicitud se resuelve localmente y devuelve el `link_calcom` del perfil. Claude no debe introducir el link en otros flujos; el postprocesamiento también elimina links de Cal.com de respuestas generadas que no correspondan a agenda.

### Consulta clínica

El bot no responde clínicamente ni inventa un canal de derivación. Exige atención directa del profesional. El sistema actual no dispone de un canal de notificación clínica.

### Administración y Claude

Las preguntas conocidas —precio, horarios, dirección, modalidad y sistemas de salud— usan respuestas locales. Las demás consultas administrativas se envían a Claude con el perfil y el historial acotado. Si Claude no está configurado o falla, el bot devuelve un fallback administrativo seguro.

## Envío y estados de entrega

- Un HTTP no exitoso de Meta es un fallo definitivo y puede reintentarse.
- Un timeout, excepción de red o respuesta 2xx sin ID se marca `delivery_uncertain` porque Meta pudo aceptar el envío aunque el resultado local fuera incompleto.
- `delivery_uncertain` no se reenvía automáticamente; evita duplicados a costa de una intervención manual.
- Si Meta confirma el envío y falla la persistencia, el evento queda `completed` con `persistence_failed` para no repetir la respuesta.

## `send-message`

`supabase/functions/send-message/` es un despachador interno protegido. Exige `INTERNAL_FUNCTION_SECRET`, valida `to` y `message`, y delega el envío a Meta. No es una Edge Function pública sin autenticación.

## Límites

- Solo hay un perfil y el fallback de fila única pertenece exclusivamente a la Fase 1.
- El acceso usa `service_role`, que bypassa RLS y debe permanecer server-side.
- No hay dashboard, Google Auth ni ownership por usuario.
- No hay RAG, análisis clínico, canal de escalamiento, consentimiento ni retención/borrado de historial.
- El inbound soporta únicamente texto.
