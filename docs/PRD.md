# PRD — Secretaria Virtual para Psicólogos

## 1. Resumen
Los pacientes que buscan psicólogo hoy se topan con información ambigua o desactualizada: modalidad de atención, horarios reales y precio no están claros, y solo se consiguen escribiendo directo por WhatsApp/Instagram, con respuestas lentas o inconsistentes. El psicólogo independiente (sin secretaria) pierde tiempo respondiendo lo mismo una y otra vez, y probablemente pacientes por demorar en contestar.

**Solución:** un bot de WhatsApp con IA que responde en nombre del psicólogo las preguntas administrativas (horarios, modalidad, precio, dirección, sistemas de salud), usando datos que el propio psicólogo configura, y entrega el link de Cal.com cuando el paciente quiere agendar.

## 2. Usuarios y Roles
- **Usuario principal y quien paga:** el psicólogo independiente.
- **Usuario secundario (interactúa, no paga ni se registra):** el paciente, vía WhatsApp.

**Flujo del psicólogo:** se registra con Google → configura sus datos y conecta su WhatsApp → el bot queda operando solo.
**Flujo del paciente:** escribe al WhatsApp del psicólogo → el bot responde → si quiere agendar, recibe el link de Cal.com.

## 3. Alcance del V1

**V1 imprescindible**
1. Registro y login del psicólogo (Google)
2. Configuración de datos de consulta (modalidad, dirección, precio, tipo de cita, sistemas de salud, link de Cal.com, número de WhatsApp)
3. Bot que responde preguntas del paciente usando esos datos
4. Bot que entrega el link de Cal.com cuando el paciente quiere agendar

**Después de validar:** confirmación manual de pago, conexión de calendario propia (reemplazando Cal.com), Instagram como canal adicional, métricas básicas en el dashboard.

**Futuro:** bot que agenda directo sin pasar por Cal.com, recordatorios automáticos al paciente.

## 4. Funcionalidades — Criterios de aceptación

| # | Función | Prioridad | Criterio de terminado |
|---|---------|-----------|------------------------|
| F1 | Registro y login | P0 | Login con Google. Dashboard vacío con menú lateral al primer ingreso. |
| F2 | Configuración de datos de consulta | P0 | Modalidad, dirección, precio, tipo de cita, sistemas de salud y número de WhatsApp son obligatorios. No se guarda si falta alguno. |
| F3 | Bot responde preguntas del paciente | P0 | Responde horarios, modalidad, dirección, precio, sistemas de salud. Deriva al psicólogo cualquier pregunta clínica o personal. |
| F4 | Bot entrega link de Cal.com | P0 | Solo cuando el paciente dice explícitamente que quiere agendar/reservar. |

## 5. Stack Tecnológico

| Pieza | Herramienta | Costo para empezar |
|---|---|---|
| Canal de conversación | WhatsApp Business API (Cloud API de Meta) | $0 — pago por mensaje en producción |
| Motor de IA | Claude API (Haiku 4.5) | $0 de licencia, pago por uso (tokens) |
| Base de datos + Login + Backend | Supabase | $0 |
| Hosting del dashboard | Cloudflare Pages | $0 (permite uso comercial) |

**Costo inicial total: $0.**

## 6. Arquitectura

**Flujo 1 — Configuración:** Psicólogo → Cloudflare Pages (dashboard) → login con Google (Supabase Auth) → formulario → Supabase (base de datos).

**Flujo 2 — Conversación:** Paciente escribe primero → WhatsApp API (Meta) → Edge Function en Supabase → busca datos del psicólogo → Claude API redacta la respuesta → Edge Function responde por WhatsApp → si pide agendar, entrega link de Cal.com.

El paciente siempre debe escribir primero, para mantenerse dentro de la ventana gratuita de 24h de WhatsApp.

## 7. Modelo de Datos

**Tabla `psicologos`:** id, nombre, email, google_id, numero_whatsapp, modalidad, direccion, precio, tipo_de_cita, sistemas_de_salud, link_calcom, fecha_registro.

**Tabla `conversaciones`:** id, psicologo_id, numero_paciente (dato personal), historial, ultima_actividad.

**Reglas de acceso:** cada psicólogo solo ve/edita su propia fila (Row Level Security). `conversaciones` solo la toca el backend.

## 8. Seguridad Mínima
- Validación en el servidor, nunca confiar solo en lo que llega desde la pantalla.
- Claves y secretos (WhatsApp, Claude, Supabase) fuera del frontend.
- Protección contra bots en login: cubierta por el login con Google.

## 9. Roadmap
1. **Fase 1 (próxima):** probar que el bot conversa bien, con un psicólogo de prueba cargado a mano.
2. **Fase 2:** dashboard con login y configuración — cualquier psicólogo se registra solo.
3. **Fase 3:** piloto con 2-3 psicólogos reales y pacientes de verdad.

---
MVP Forge · Álvaro Labs
