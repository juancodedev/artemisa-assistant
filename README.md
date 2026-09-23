# 🎭 Artemisa Assistant — Secretaria Virtual

Bot de WhatsApp con IA para psicólogos independientes. Responde preguntas administrativas de pacientes y entrega links de Cal.com para agendar citas.

## Fase 1 — Bot Conversacional

### Stack
- **WhatsApp Business API** (Cloud API de Meta)
- **Claude API** (Haiku 4.5)
- **Supabase** (Postgres + Edge Functions)

### Estructura del proyecto

```
artemisa-assistant/
├── supabase/
│   ├── migrations/          # SQL migrations para tablas
│   │   ├── 001_create_psicologos.sql
│   │   ├── 002_create_conversaciones.sql
│   │   └── 003_seed_test_psicologo.sql
│   ├── functions/           # Edge Functions
│   │   ├── webhook/         # Recibe mensajes de WhatsApp
│   │   ├── send-message/    # Envía mensajes
│   │   └── supabase-client/ # Cliente Supabase compartido
│   └── supabase.json        # Configuración del proyecto
├── src/
│   ├── bot/
│   │   ├── index.ts         # Punto de entrada principal
│   │   ├── router.ts        # Routing: admin vs clínica
│   │   ├── claude.ts        # Integración Claude Haiku 4.5
│   │   └── handlers/
│   │       ├── admin.ts     # Preguntas administrativas
│   │       ├── scheduling.ts# Cal.com link
│   │       └── forwarder.ts # Deriva preguntas clínicas
│   ├── services/
│   │   ├── supabase.ts      # Acceso a datos
│   │   └── whatsapp.ts      # Cliente WhatsApp Business API
│   ├── types/
│   │   └── index.ts         # Tipos TypeScript
│   └── utils/
│       └── validation.ts    # Validación de entrada
├── deno.json
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

### Base de datos
- **Proyecto Supabase**: `artemisa-assistant` (ref: `ihxlziemvtukpixnptob`)
- **Tabla `psicologos`**: 1 registro de prueba cargado
- **Tabla `conversaciones`**: lista para almacenar historial

### Edge Functions desplegadas
- `webhook` → recibe mensajes de Meta WhatsApp
- `send-message` → envía respuestas
- `supabase-client` → utilidad compartida

## Seguridad
- Todas las claves viven en variables de entorno (`.env`)
- Validación de datos en el servidor
- El `service_role` key NUNCA se expone al cliente

## Próximos pasos
1. Configurar credenciales de WhatsApp (Meta App ID, Phone Number ID, Access Token)
2. Configurar API Key de Anthropic
3. Configurar variables de entorno en el dashboard de Supabase
4. Probar el webhook con un número real de WhatsApp
5. Fase 2: Dashboard + login + formulario de configuración
