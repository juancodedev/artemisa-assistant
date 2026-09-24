# Usuarios y roles

## Estado de la Fase 1

| Actor | Interacción | Cuenta en el sistema | Datos asociados |
|---|---|---|---|
| Psicólogo demo | Propietario operativo del número de WhatsApp demo | No | Perfil en `psicologos` |
| Paciente | Escribe al WhatsApp del psicólogo | No | Número normalizado e historial en `conversaciones` |
| Operador técnico | Configura secretos, migra y despliega | No | Acceso operativo a Supabase y Meta |

## Psicólogo

En la Fase 1 no hay registro, login, dashboard ni editor de perfil. Los datos se administran mediante migraciones, seeds o SQL y se cargan en un perfil demo único. La propiedad individual del perfil todavía no existe.

En la Fase 2 se agregarán Google Auth, configuración de perfil y políticas RLS que vinculen cada registro con su propietario.

## Paciente

El paciente no crea una cuenta. Sin embargo, **sí queda registrado en la base de datos**:

- `conversaciones.numero_paciente` almacena el número de WhatsApp.
- `conversaciones.historial` conserva el contexto de la conversación.
- El historial enviado a Claude se limita a los 20 mensajes más recientes.

En una ruta de crisis, el texto entrante no se persiste. Se almacena un marcador redactado y la respuesta de seguridad. Para el resto de las rutas se conservan el mensaje y la respuesta en el historial.

## Límites actuales

- No hay consentimiento digital ni mecanismo de acceso, exportación o eliminación del historial.
- No existe una cuenta que vincule al paciente con el profesional.
- No existe notificación al psicólogo ni canal clínico de escalamiento.
- El `service_role` accede desde el servidor y bypassa RLS; no debe exponerse al navegador.
