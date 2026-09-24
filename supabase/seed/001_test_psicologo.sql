-- Seed: Test psychologist (the only one for Phase 1)
-- Keep meta_phone_number_id NULL until the real Meta value is configured.
-- The runtime fallback is allowed only while this is the sole psychologist row.
insert into public.psicologos (
  nombre,
  numero_whatsapp,
  meta_phone_number_id,
  modalidad,
  direccion,
  precio,
  tipo_de_cita,
  sistemas_de_salud,
  link_calcom
) values (
  'Dr/a. María López',
  '+5491123456789',
  null,
  'Presencial y Virtual',
  'Av. Corrientes 1234, Buenos Aires',
  '$15.000 ARS por sesión',
  'Sesión única / Paquete de 4 sesiones',
  '{"OSDE", "Swiss Medical", "Galeno", "IAPS"}',
  'https://cal.com/juancode-dev/dr-maria-lopez'
)
on conflict (numero_whatsapp) do nothing;
