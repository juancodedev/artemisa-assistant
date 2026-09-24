-- Seed: Demo psychologist (the only one for Phase 1)
-- Reuses the existing row when numero_whatsapp already exists so remote and
-- fresh-reset environments converge on the same profile without changing its ID.
insert into public.psicologos (
  nombre,
  numero_whatsapp,
  meta_phone_number_id,
  modalidad,
  direccion,
  precio,
  tipo_de_cita,
  sistemas_de_salud,
  link_calcom,
  horarios
) values (
  'Dra. María López',
  '+5491123456789',
  '1247109808496718',
  'Presencial y virtual',
  'Consultorio Demo — Av. Siempre Viva 742, Santiago',
  '$35.000 CLP por sesión de 50 minutos',
  'Sesión individual de 50 minutos',
  '{"Plan Demo A", "Plan Demo B"}',
  'https://cal.com/juancode-dev/dr-maria-lopez',
  'Lunes a viernes de 09:00 a 18:00, hora de Chile.'
)
on conflict (numero_whatsapp) do update
set
  nombre = excluded.nombre,
  meta_phone_number_id = excluded.meta_phone_number_id,
  modalidad = excluded.modalidad,
  direccion = excluded.direccion,
  precio = excluded.precio,
  tipo_de_cita = excluded.tipo_de_cita,
  sistemas_de_salud = excluded.sistemas_de_salud,
  link_calcom = excluded.link_calcom,
  horarios = excluded.horarios;
