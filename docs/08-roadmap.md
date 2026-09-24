# Roadmap

## Leyenda

| Etapa | Significado |
|---|---|
| **Fase 1** | Alcance actual implementado y verificable en el repositorio |
| **Fase 2** | Próxima etapa: autoadministración y operación multiusuario |
| **Más adelante** | Validación posterior; no es una garantía ni una funcionalidad actual |

## Fase 1 — Bot de texto con perfil demo

**Estado: implementada.** No es la próxima fase.

- WhatsApp Business Cloud API real mediante Supabase Edge Functions.
- Verificación HMAC, status events y parsing multi-message.
- Un perfil ficticio cargado desde el seed activo.
- Routing de crisis, agenda explícita, rechazo clínico, administración local y fallback de Claude.
- Historial almacenado con contexto acotado a 20 mensajes.
- Idempotencia por `wamid` y estado `delivery_uncertain`.
- Node y Deno verificados por CI.

### Límites aceptados en Fase 1

- Perfil único; fallback de fila única únicamente cuando no hay varias filas.
- Sin Google Auth, dashboard ni editor de perfil.
- Sin RAG ni base vectorial.
- Sin consentimiento, retención o eliminación de datos.
- Sin canal de notificación clínica.
- Solo inbound de texto.
- Detección de crisis heurística.

## Fase 2 — Autoadministración y ownership

**Estado: diferida.**

- Google Auth para el psicólogo.
- Dashboard responsive para consultar y editar el perfil.
- Asociación del perfil con `auth.uid()`.
- Políticas RLS de ownership para perfil y conversaciones.
- Gestión explícita de varios `meta_phone_number_id` sin fallback de fila única.
- Eliminación del fallback de perfil único cuando la propiedad esté vigente.

## Fase 2 — Datos y operación segura

Puede avanzar junto con la autoadministración:

- Consentimiento y política de retención.
- Exportación y eliminación de datos.
- Procedimiento para revisar `delivery_uncertain` y fallos de persistencia.
- Observabilidad, alertas y trazabilidad operativa.
- Validación de que ninguna credencial o dato sensible llegue al cliente.

## Más adelante — Piloto y canales

- Piloto con varios profesionales y pacientes reales.
- Métricas de uso, agenda y calidad de las respuestas.
- Calendario propio, recordatorios y canales adicionales.
- Evaluación de RAG solo si el modelo estructurado de `psicologos` deja de ser suficiente.

No se deben presentar estas etapas como certificación clínica, garantía legal o escalamiento profesional. La respuesta de crisis actual entrega recursos aprobados y una derivación explícita a atención profesional, pero no notifica a un psicólogo.
