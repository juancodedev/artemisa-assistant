# Privacidad y consentimiento

Cómo trata Artemisa los datos de los pacientes y qué pasos de operación requiere. El texto legal definitivo debe validarlo un abogado antes de publicarse.

## Qué hace el bot

| Situación | Respuesta | Qué se guarda |
|---|---|---|
| Señal de crisis | Línea de prevención (*4141), siempre primero, aunque falle la base | Solo si hay consentimiento vigente: un marcador `[mensaje de crisis omitido]` |
| Sin consentimiento | Respuestas fijas (precio, horario, ubicación, agenda) más el aviso de consentimiento | El aviso mostrado (`consent_prompts`) y el contador de mensajes |
| `ACEPTO` después de ver el aviso | Confirmación | Un evento `granted` en `consent_events` con versión y `wamid` |
| Con consentimiento vigente | Pipeline completo, incluido Claude | Historial; el texto clínico o de crisis se guarda como marcador |

El aviso completo se envía una vez por versión de política. Después se envía un recordatorio corto con el enlace. Un `ACEPTO` que llega antes de ver el aviso no cuenta: el bot envía el aviso.

El bot no avisa al profesional. El texto de consentimiento dice que nadie lee el canal.

## Versiones de la política

- `consent_policies` guarda cada versión. Con `vigente_desde` en `NULL` es un borrador y se puede editar.
- Una versión publicada no se puede modificar ni borrar.
- La versión vigente es la publicada con el `vigente_desde` más reciente que no esté en el futuro.
- Publicar una versión nueva vuelve a pedir el consentimiento a todos.
- Los consentimientos de la migración 006 (`sender_consents`) no se migran: aceptaron un texto incompleto, así que se vuelve a pedir.

### Publicar la política

La migración 007 crea el borrador `2026-11-borrador`. Mientras no haya una versión publicada, nadie puede consentir y el bot solo responde preguntas fijas.

Con el texto aprobado y la política completa publicada en una URL:

```sql
update public.consent_policies
set texto = '<texto aprobado, con {profesional} y la palabra ACEPTO>',
    politica_url = 'https://<dominio>/privacidad',
    vigente_desde = now()
where version = '2026-11-borrador';
```

Para cambiar una política ya publicada, inserta una versión nueva; no edites la anterior. El `service_role` solo puede leer las políticas: publícalas desde el editor SQL.

No publiques la política antes de desplegar la migración 008 y la Edge Function que atiende `BAJA` y `ELIMINAR`: el texto los promete.

## Derechos por WhatsApp

| Mensaje | Qué hace | Qué se conserva |
|---|---|---|
| `BAJA` | Agrega un evento `revoked` si había una autorización vigente | El historial, hasta `ELIMINAR` o hasta el borrado por retención |
| `ELIMINAR` | Retira la autorización y borra la conversación, los avisos mostrados, los contadores de mensajes de más de dos horas y el consentimiento heredado de 006 | `consent_events`, y los contadores de las últimas dos horas para que `ELIMINAR` no reinicie el límite de mensajes (el borrado por retención los elimina en un día) |

Las dos palabras se aceptan sin importar mayúsculas ni tildes, pero solas: "quiero darme de baja del plan" no cuenta. Se atienden antes del límite de mensajes y sin exigir consentimiento. Si la base falla, el bot lo dice y no confirma nada.

### Límites conocidos

- Un mensaje que ya pasó el filtro antes de un `BAJA` o `ELIMINAR` vuelve a leer el consentimiento justo antes de guardar la respuesta, y no guarda nada si ya se retiró. Si llegó a `getOrCreateConversacion` después del borrado, puede quedar una conversación vacía, que el borrado por retención elimina. Queda una ventana de milisegundos entre esa última lectura y el guardado.
- `BAJA` y `ELIMINAR` no consumen el límite de mensajes, a propósito: ejercer un derecho no puede depender de cuántos mensajes se enviaron. Repetirlos no tiene costo de Claude; cada uno hace consultas por índice y envía una respuesta.

## Retención

`purge_expired_personal_data(interval '90 days')` borra:

- conversaciones sin actividad en ese plazo;
- avisos de consentimiento mostrados hace más de ese plazo;
- filas de idempotencia (`mensajes_procesados`) de más de ese plazo;
- contadores de mensajes de más de un día.

Nunca toca `consent_events` y rechaza plazos menores a un día.

La migración no programa el borrado. La primera ejecución borra de una vez todas las conversaciones que ya superan los 90 días, y no se puede deshacer. Antes de programarlo, revisa cuántas se borrarían y ejecuta a mano `supabase/scripts/schedule_retention_purge.sql`, que activa `pg_cron` y agenda la tarea todos los días a las 07:00 UTC.

## Registro de consentimiento

`consent_events` es solo de inserción: un trigger rechaza `UPDATE`, `DELETE` y `TRUNCATE`, y el `service_role` solo tiene `SELECT` e `INSERT`. El último evento de cada remitente decide el estado.

## Pruebas de base de datos

`supabase/tests/consent_and_retention.test.sql` prueba las migraciones 007 y 008 contra un Postgres real y deshace todo al terminar:

```bash
docker run -d --rm --name artemisa-pg-test -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:17-alpine
export PGPASSWORD=test
psql -h localhost -p 55432 -U postgres -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create schema auth; create function auth.role() returns text language sql as \$\$ select 'anon'::text \$\$;"
for f in supabase/migrations/*.sql; do psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 -q -f "$f"; done
psql -h localhost -p 55432 -U postgres -v ON_ERROR_STOP=1 -f supabase/tests/consent_and_retention.test.sql
docker stop artemisa-pg-test
```

Los roles y el esquema `auth` reemplazan lo que Supabase ya trae.
