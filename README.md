# Artemisa Assistant — Secretaria virtual

Bot de WhatsApp que actúa como secretaria virtual de un psicólogo independiente. La implementación actual corresponde a la **Fase 1**: un bot de texto para WhatsApp, un perfil de demostración y ejecución en Supabase Edge Functions con Deno.

## Estado actual

| Área | Estado |
|---|---|
| Canal | WhatsApp Business Cloud API de Meta |
| Perfil knowledge source | Una fila de `psicologos`; no existe RAG ni base vectorial |
| Runtime de producción | Supabase Edge Functions sobre Deno |
| Compatibilidad local | Árbol Node/TypeScript en `src/` |
| IA | Respuestas administrativas locales y fallback de Anthropic/Claude |
| Agendamiento | Link de Cal.com únicamente ante una solicitud explícita |
| Próxima fase | Google Auth, dashboard, editor de perfil y propiedad por usuario |

## Inicio rápido

```bash
npm ci
npm test
npx tsc --noEmit
npm run test:edge
```

Validación de tipos de las pruebas Edge, con la línea Deno 2.1.x usada por CI (la ejecución Docker verificada usó 2.1.4):

```bash
deno check --config supabase/functions/deno.json --no-lock supabase/functions/_shared/phase1.test.ts
```

Para aplicar migraciones en el proyecto Supabase vinculado:

```bash
npm run db:migrate
```

Para desplegar las dos funciones separadas:

```bash
npm run deploy:webhook
npm run deploy:send-message
```

GitHub Actions ejecuta las pruebas y verificaciones de tipos, pero **no despliega**.

## Estructura relevante

```text
supabase/
├── config.toml                         # Seed activo y configuración de funciones
├── migrations/
│   ├── 001_create_psicologos.sql
│   ├── 002_create_conversaciones.sql
│   ├── 003_seed_test_psicologo.sql    # Migración histórica aplicada
│   └── 004_phase1_p0_security_context.sql
├── seed/
│   └── 001_test_psicologo.sql          # Seed activo de Supabase CLI
└── functions/
    ├── _shared/                        # Lógica compartida del runtime Deno
    │   ├── auth.ts
    │   ├── batch.ts
    │   ├── bot.ts
    │   ├── claude.ts
    │   ├── router.ts
    │   ├── supabase.ts
    │   ├── types.ts
    │   ├── validation.ts
    │   ├── whatsapp.ts
    │   └── phase1.test.ts
    ├── webhook/                        # Entrada de eventos de Meta
    ├── send-message/                   # Envío interno protegido
    └── deno.json
src/                                    # Árbol Node/local de compatibilidad
tests/                                  # Pruebas del árbol Node
.github/workflows/tests.yml            # CI de Node y Deno
openspec/config.yaml                   # Reglas y comandos de verificación
docs/                                   # Documentación funcional y técnica
```

## Flujo de producción

```text
Meta webhook
  -> verificación HMAC sobre el cuerpo crudo
  -> parsing de todos los mensajes del payload
  -> reserva del wamid
  -> selección del perfil por meta_phone_number_id
  -> historial limitado a 20 mensajes
  -> crisis / agendamiento explícito / rechazo clínico / respuesta local / Claude
  -> envío de texto por Meta
  -> persistencia e idempotencia final
```

Las señales de crisis se procesan antes que cualquier otra ruta y no se envían a Claude. El texto bruto de crisis no se persiste: en el historial se guarda un marcador redactado.

## Perfil demo

Los siguientes datos son **ficticios y solo de demostración**:

| Campo | Valor |
|---|---|
| Nombre | Dra. María López |
| WhatsApp | `+5491123456789` |
| `meta_phone_number_id` | `1247109808496718` |
| Modalidad | Presencial y virtual |
| Dirección | Consultorio Demo — Av. Siempre Viva 742, Santiago |
| Precio | $35.000 CLP por sesión de 50 minutos |
| Tipo de sesión | Sesión individual de 50 minutos |
| Sistemas de salud | Plan Demo A; Plan Demo B |
| Horarios | Lunes a viernes de 09:00 a 18:00, hora de Chile. |
| Agendamiento | `https://cal.com/juancode-dev/dr-maria-lopez` |

La fuente activa es `supabase/seed/001_test_psicologo.sql`. `supabase/migrations/003_seed_test_psicologo.sql` conserva datos históricos ya aplicados y no es el seed operativo de Supabase CLI.

## Límites de la Fase 1

- Los pacientes no tienen cuenta, pero su número e historial de conversación sí se almacenan en Supabase.
- No existe flujo de consentimiento, retención ni eliminación de datos.
- La detección de crisis por palabras clave es heurística y no reemplaza una evaluación clínica.
- No existe un canal de notificación al psicólogo.
- El inbound admite solo texto.
- El rol `service_role` omite RLS y debe permanecer exclusivamente en el servidor.

## Documentación

- [Resumen](docs/01-resumen.md)
- [Usuarios](docs/02-usuarios.md)
- [MVP](docs/03-mvp.md)
- [Funcionalidades](docs/04-funcionalidades.md)
- [Stack](docs/05-stack.md)
- [Arquitectura](docs/06-arquitectura.md)
- [Base de datos](docs/07-base-de-datos.md)
- [Roadmap](docs/08-roadmap.md)
- [Runbook de inicio](docs/INICIAR-DESARROLLO.md)
- [PRD](docs/PRD.md)
