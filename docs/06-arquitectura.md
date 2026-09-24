# Arquitectura

## Flujo 1 — El psicólogo configura sus datos
```
Psicólogo (navegador)
  → Cloudflare Pages (dashboard)
  → Inicia sesión con Google (Supabase Auth)
  → Llena el formulario de configuración
  → Se guarda en Supabase (base de datos)
```

## Flujo 2 — El paciente conversa con el bot
```
Paciente (WhatsApp) escribe primero
  → WhatsApp Business API (Meta)
  → Edge Function en Supabase (código que se activa al recibir el mensaje)
  → Busca los datos del psicólogo en la base de datos
  → Envía esos datos + la pregunta del paciente a Claude API
  → Claude redacta la respuesta
  → Edge Function envía la respuesta de vuelta por WhatsApp
  → Si el paciente pide agendar → se le entrega el link de Cal.com del psicólogo
```

**Importante:** el paciente siempre debe escribir primero (nunca el bot inicia la conversación), porque eso determina si el mensaje entra en la ventana gratuita de 24 horas de WhatsApp.

---
MVP Forge · Álvaro Labs
