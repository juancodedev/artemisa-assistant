# Resumen del proyecto

## Decisión de producto

Artemisa Assistant es una secretaria virtual para psicólogos independientes. La **Fase 1 actual** automatiza, mediante WhatsApp, las consultas administrativas más repetitivas de un único perfil profesional. El paciente no necesita crear una cuenta; el psicólogo no tiene dashboard ni login en esta fase.

## Problema

Los pacientes suelen obtener modalidad, ubicación, horarios y precio escribiendo directamente al profesional. Esto genera respuestas repetitivas, demoras y información que puede quedar desactualizada. El psicólogo independiente pierde tiempo operativo y puede perder oportunidades de contacto.

## Respuesta implementada

El bot recibe mensajes de texto por WhatsApp, identifica el perfil demo y responde con información almacenada en Supabase. El conocimiento proviene de la tabla `psicologos`; no existe RAG ni indexación vectorial.

La ruta de respuesta se evalúa en este orden:

1. Señal de crisis.
2. Solicitud explícita de agendamiento.
3. Consulta clínica que requiere atención profesional.
4. Respuesta administrativa local.
5. Claude como fallback para una consulta no cubierta localmente.

Las señales de crisis tienen prioridad absoluta, no llaman a Claude, entregan únicamente los recursos aprobados `*4141` y Salud Responde `600 360 7777` opción 2, y guardan un marcador redactado en lugar del texto original. El código y sus pruebas son la fuente de verdad del texto exacto.

## Estado de la Fase 1

- WhatsApp real con webhook de Meta y validación HMAC.
- Un perfil ficticio de demostración.
- Supabase Edge Functions como runtime de producción.
- Historial acotado a 20 mensajes por interacción con Claude.
- Idempotencia persistente por `wamid`.
- Link de Cal.com solo ante una solicitud explícita.
- Pruebas y typecheck de Node y Deno incorporados a CI.

## Fuera de alcance actual

Google Auth, dashboard, formulario de edición, múltiples profesionales con propiedad por usuario, RAG, consentimiento y ciclo de retención de datos, notificaciones clínicas y canales adicionales de entrada permanecen en Fase 2 o etapas posteriores.

---

MVP Forge · Álvaro Labs
