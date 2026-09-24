# Funcionalidades del V1

## F1 — Registro y login de psicólogo (P0)
**Criterio de terminado:** el psicólogo se registra e inicia sesión con su cuenta de Google (sin formulario de correo/contraseña propio). Al ingresar por primera vez, ve un dashboard vacío con el menú lateral de las opciones disponibles.
**Dependencia:** login con Google (vía Supabase Auth).

## F2 — Configuración de datos de consulta (P0)
**Criterio de terminado:** modalidad, dirección, precio, tipo de cita, sistemas de salud y número de WhatsApp son campos obligatorios. El formulario no se puede guardar si falta alguno — así el bot siempre tiene información completa para responder.

## F3 — Bot que responde preguntas del paciente (P0)
**Criterio de terminado:** el bot responde correctamente sobre horarios, modalidad, dirección, precio y sistemas de salud, usando los datos de F2. Si la pregunta es clínica o personal (no administrativa), no intenta responderla — indica que eso se conversa directo con el psicólogo.

## F4 — Bot entrega link de Cal.com (P0)
**Criterio de terminado:** el bot entrega el link de Cal.com del psicólogo únicamente cuando el paciente expresa explícitamente su intención de agendar/reservar — no lo ofrece de forma proactiva ni automática al inicio de la conversación.

---
MVP Forge · Álvaro Labs
