-- Create psicologos table
create table public.psicologos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  numero_whatsapp text not null unique,
  modalidad text not null,
  direccion text not null,
  precio text not null,
  tipo_de_cita text not null,
  sistemas_de_salud text[] not null default '{}',
  link_calcom text not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS
alter table public.psicologos enable row level security;

-- Policy: anon and authenticated roles can read psicologos (needed for the bot to look up data)
create policy "Public read access on psicologos"
  on public.psicologos
  for select
  to anon, authenticated
  using (true);

-- Policy: service_role can do everything (for Edge Functions admin operations)
-- This is handled by the service_role key, not a policy

-- Create trigger function for updated_at
create or replace function public.trigger_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger for updated_at
create trigger set_updated_at
  before update on public.psicologos
  for each row
  execute function public.trigger_set_updated_at();
