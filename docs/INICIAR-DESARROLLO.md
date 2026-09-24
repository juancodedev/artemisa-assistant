# Runbook de inicio — Fase 1

## Estado operativo

La Fase 1 usa Supabase Edge Functions con Deno como runtime productivo. `src/` es únicamente el árbol Node/local de compatibilidad. El bot procesa únicamente texto de WhatsApp para un perfil demo.

## Requisitos

- Node.js 22, según el CI actual.
- Deno 2.1.x, la línea usada por CI; la ejecución Docker verificada usó 2.1.4.
- Supabase CLI vinculado al proyecto objetivo.
- Dependencias instaladas desde el lockfile con `npm ci`.

No se incluyen valores de secretos en este documento.

## 1. Preparación local

```bash
npm ci
```

Variables para las pruebas y el árbol local se gestionan fuera de la documentación. No copie valores reales a archivos versionados.

## 2. Base de datos

El seed activo se define en `supabase/config.toml`:

```text
supabase/seed/001_test_psicologo.sql
```

Para recrear la base local aplicando migraciones y el seed activo:

```bash
supabase db reset
```

Para aplicar las migraciones pendientes en el proyecto Supabase vinculado:

```bash
npm run db:migrate
```

Orden efectivo de esquema:

1. `001_create_psicologos.sql`
2. `002_create_conversaciones.sql`
3. `003_seed_test_psicologo.sql` — dato histórico aplicado
4. `004_phase1_p0_security_context.sql`

`003_seed_test_psicologo.sql` no es el seed operativo. El perfil demo vigente está en `supabase/seed/001_test_psicologo.sql`.

## 3. Variables de servidor

Configurar como secretos de Supabase, sin guardar sus valores en el repositorio:

| Secreto | Necesario | Uso |
|---|---|---|
| `SUPABASE_URL` | Sí | URL del proyecto |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí | Acceso server-side; bypassa RLS |
| `META_APP_SECRET` | Sí | HMAC del webhook |
| `META_WEBHOOK_VERIFY_TOKEN` | Sí | Challenge GET de Meta |
| `META_PHONE_NUMBER_ID` | Sí | Número emisor de Meta |
| `META_ACCESS_TOKEN` | Sí | Graph API de Meta |
| `ANTHROPIC_API_KEY` | Sí para Claude | Fallback de IA |
| `INTERNAL_FUNCTION_SECRET` | Sí | Autorización de `send-message` |
| `META_GRAPH_API_VERSION` | Opcional | Sobrescribe `v25.0` con un valor válido |
| `META_FETCH_TIMEOUT_MS` | Opcional | Timeout de Meta, acotado por el runtime |
| `ANTHROPIC_MODEL` | Opcional | Sobrescribe el modelo por defecto |
| `ANTHROPIC_WORKSPACE_ID` | Opcional | Workspace de Anthropic |

Checklist antes de probar:

- [ ] El proyecto Supabase está vinculado al entorno correcto.
- [ ] Las migraciones 001–004 están aplicadas.
- [ ] El seed demo activo está cargado o es posible cargarlo.
- [ ] `SUPABASE_SERVICE_ROLE_KEY` no está expuesta al cliente.
- [ ] Meta y Anthropic tienen secretos configurados en el servidor.
- [ ] El endpoint webhook de Meta usa HTTPS.

## 4. Verificación local

```bash
npm test
npx tsc --noEmit
deno check --config supabase/functions/deno.json --no-lock supabase/functions/_shared/phase1.test.ts
npm run test:edge
```

Estos comandos validan el árbol Node y el runtime Deno. No realizan despliegue.

## 5. Deploy controlado

```bash
npm run deploy:webhook
npm run deploy:send-message
```

Las funciones se despliegan por separado después de revisar el estado de las migraciones y los secretos.

La configuración de Supabase mantiene `verify_jwt = false` porque el webhook valida su propia autenticación con HMAC y `send-message` usa `INTERNAL_FUNCTION_SECRET`. Esta configuración no convierte al webhook en un endpoint público sin protección: la firma de Meta es obligatoria.

## 6. Prueba de WhatsApp

1. Confirmar que Meta apunta al endpoint de la función `webhook`.
2. Completar el challenge GET con el token configurado.
3. Enviar un texto desde un número de prueba al número de WhatsApp demo.
4. Verificar la respuesta administrativa, la persistencia en `conversaciones` y el estado final en `mensajes_procesados`.
5. Probar una solicitud explícita de agenda y verificar que entrega el link de Cal.com.
6. Probar una consulta clínica y verificar que no se responde clínicamente.
7. Probar una señal de crisis y verificar los dos recursos aprobados.

## Comportamiento de crisis

La ruta de crisis se ejecuta antes de agenda, clínica, administración local y Claude. No llama a Claude, no incluye Cal.com ni `133`, y no promete que se notificará al psicólogo. El texto original no se persiste: se guarda un marcador redactado. La respuesta exacta está en el código y las pruebas, no en esta runbook.

## Límites conocidos

- Se almacenan número e historial del paciente; no hay consentimiento, retención ni eliminación.
- La detección de crisis es heurística.
- No existe canal de notificación clínica.
- El `service_role` bypassa RLS y debe permanecer en Edge Functions.
- Solo se admite texto; audio, imagen y documento reciben una respuesta informativa.
- `send-message` es interno y protegido; no debe usarse como API pública.
