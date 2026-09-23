-- Create conversaciones table
create table public.conversaciones (
  id uuid primary key default gen_random_uuid(),
  psicologo_id uuid references public.psicologos(id) on delete cascade not null,
  numero_paciente text not null,
  historial jsonb not null default '[]',
  ultima_actividad timestamptz default now(),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Enable RLS
alter table public.conversaciones enable row level security;

-- Policy: anon and authenticated roles can read their own conversaciones
-- Policy: service_role can do everything (for Edge Functions)
create policy "Service role full access"
  on public.conversaciones
  for all
  to authenticated
  using (auth.role() = 'authenticated')
  with check (auth.role() = 'authenticated');

-- Policy: read-only for anon (bot needs to read conversation history)
create policy "Anon read access on conversaciones"
  on public.conversaciones
  for select
  to anon
  using (true);

-- Index for faster lookups by paciente number
create index idx_conversaciones_numero_paciente
  on public.conversaciones(numero_paciente);

-- Index for faster lookups by psicologo_id
create index idx_conversaciones_psicologo_id
  on public.conversaciones(psicologo_id);

-- Create trigger function for updated_at (if not already exists from migration 1)
create or replace function public.trigger_set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger for updated_at
create trigger set_updated_at
  before update on public.conversaciones
  for each row
  execute function public.trigger_set_updated_at();
