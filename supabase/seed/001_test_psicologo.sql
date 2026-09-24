-- Seed: Test psychologist (the only one for Phase 1)
insert into public.psicologos (
  nombre,
  numero_whatsapp,
  modalidad,
  direccion,
  precio,
  tipo_de_cita,
  sistemas_de_salud,
  link_calcom
) values (
  'Dr/a. María López',
  '+5491123456789',
  'Presencial y Virtual',
  'Av. Corrientes 1234, Buenos Aires',
  '$15.000 ARS por sesión',
  'Sesión única / Paquete de 4 sesiones',
  '{"OSDE", "Swiss Medical", "Galeno", "IAPS"}',
  'https://cal.com/juancode-dev/dr-maria-lopez'
);
