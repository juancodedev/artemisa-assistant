# Plan de trabajo

Estado al 10 de noviembre de 2026 y próximos pasos. Complementa `08-roadmap.md` con tareas concretas.

## Estado actual

En producción (proyecto `ihxlziemvtukpixnptob`):

- Migraciones 001 a 009 aplicadas y Edge Function `webhook` desplegada.
- Consentimiento versionado (`ACEPTO`), retiro (`BAJA`) y borrado (`ELIMINAR`) por WhatsApp.
- Borrado automático programado con `pg_cron`: tarea `artemisa-retention-purge`, todos los días a las 07:00 UTC, 90 días sin actividad.
- La política de privacidad sigue en borrador (`2026-11-borrador`). Mientras no se publique, nadie puede consentir y el bot solo responde precio, horarios, ubicación y agenda.

## Plan de acción inmediato

| # | Tarea | Responsable | Estado |
|---|---|---|---|
| A1 | Llevar a `main` la corrección de `docs/09` que quedó fuera del PR #10 (commit "docs(privacy): list every place the 90-day retention is written") | Desarrollo | En esta rama |
| A2 | Revisión legal del texto de consentimiento y publicación de la política completa en una URL pública | Dirección, con asesoría legal | Pendiente. Objetivo: antes del 1 de diciembre de 2026, cuando entra en vigencia la Ley 21.719 |
| A3 | Publicar la política en la base con el `update` de `docs/09` (el texto debe nombrar `ACEPTO`, `BAJA` y `ELIMINAR`) | Desarrollo | Después de A2 |
| A4 | Contrato de encargo de tratamiento con cada profesional y base legal para la transferencia internacional de datos (Supabase en EE. UU., Anthropic, Meta) | Dirección, con asesoría legal | Pendiente |
| A5 | Exportación de datos (derecho de acceso): que el paciente pueda pedir una copia de lo que se guarda sobre su número | Desarrollo | Pendiente. Requiere decidir el canal antes de implementar (ver abajo) |
| A6 | Opcional: volver a ejecutar `supabase/scripts/schedule_retention_purge.sql` para que la tarea programada use el plazo por defecto de la función. Hoy pasa `interval '90 days'` explícito, que es equivalente | Desarrollo | Opcional |

### Decisiones abiertas para A5

- **Canal:** el texto completo por WhatsApp, un archivo, o un enlace temporal. WhatsApp no garantiza que el número siga en manos del paciente, así que conviene decidir cómo se confirma la identidad.
- **Contenido:** historial guardado, eventos de consentimiento y avisos mostrados. Los mensajes clínicos ya se guardan como marcador, así que no hay texto clínico para exportar.
- **Palabra de comando:** por ejemplo `MIS DATOS`. Debe agregarse al texto de la política, y una versión publicada exige nombrar los comandos.

## Plan para múltiples psicólogos (siguiente instancia)

Objetivo: que varios profesionales usen Artemisa, cada uno con sus pacientes, su perfil y su consentimiento, sin mezclar datos ni respuestas.

### Lo que ya funciona por profesional

- Conversaciones, consentimientos, avisos mostrados y límite de mensajes llevan `psicologo_id`. Un `ELIMINAR` borra solo los datos de ese profesional.
- El texto de consentimiento nombra al profesional como responsable (`{profesional}`).
- El perfil se resuelve por `meta_phone_number_id`, el número de WhatsApp que recibió el mensaje. Hay un índice único sobre ese campo.

### Lo que falta, con su ubicación en el código

| # | Hallazgo | Dónde | Impacto |
|---|---|---|---|
| M1 | Las respuestas salen siempre del número configurado en `META_PHONE_NUMBER_ID`, no del número que recibió el mensaje | `supabase/functions/_shared/whatsapp.ts:75` | **Bloqueante:** con dos números, el paciente de un profesional recibiría la respuesta desde el número de otro |
| M2 | Si hay un solo perfil, cualquier número sin registrar cae en él (respaldo de perfil único) | `supabase/functions/_shared/supabase.ts:96` | Con varios perfiles el respaldo ya no actúa, pero debe eliminarse para que un número mal configurado no se atribuya a nadie |
| M3 | Un solo token de Meta (`META_ACCESS_TOKEN`) para todo | Variables de entorno de la Edge Function | Sirve si todos los números están en la misma cuenta de WhatsApp Business. Si cada profesional trae su propia cuenta, hace falta un token por profesional, guardado de forma segura (Supabase Vault) |
| M4 | El alta de un profesional es manual (SQL) | `psicologos` | Falta un flujo de alta y de conexión del número (Embedded Signup de Meta) |
| M5 | No hay acceso para el profesional | Fase 2 de `08-roadmap.md` | Google Auth, panel para editar el perfil, políticas RLS por dueño |
| M6 | Costos de Claude y Meta sin atribución por profesional | Edge Function | Necesario para cobrar o poner límites por profesional |
| M7 | Bot Node heredado en `src/` con su propia búsqueda de perfil (`getPsicologoByWhatsApp`) | `src/services/supabase.ts:30` | Decidir si se retira para no mantener dos caminos |

### Decisión de producto previa

**¿Un número de WhatsApp por profesional, o un número del centro que deriva a cada profesional?**

- **Un número por profesional:** encaja con el modelo actual (perfil por `meta_phone_number_id`). Cada número requiere su verificación en Meta.
- **Un número del centro:** el paciente debe elegir profesional, y el consentimiento, el historial y el borrado tienen que asociarse al profesional elegido. Requiere cambiar el modelo de datos y el flujo de conversación.

Esta decisión se toma al inicio de la próxima instancia, antes de escribir código.

### Etapas propuestas

1. **Enrutamiento por número (M1, M2):** responder desde el número que recibió el mensaje, quitar el respaldo de perfil único y probar con dos perfiles que ningún dato ni respuesta se cruza.
2. **Alta y credenciales (M3, M4):** flujo para dar de alta a un profesional y conectar su número, con credenciales por profesional si hace falta.
3. **Autoadministración (M5):** la Fase 2 del roadmap.
4. **Operación (M6, M7):** atribución de costos y retiro del bot heredado.
5. **Piloto** con varios profesionales reales, después de A2 a A4.
