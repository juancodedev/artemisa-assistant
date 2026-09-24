-- Phase 1 P0: internal webhook idempotency and profile routing support.
-- These tables are accessed only by the service-role Edge Function runtime.

alter table public.psicologos
  add column if not exists meta_phone_number_id text,
  add column if not exists horarios text;

create unique index if not exists idx_psicologos_meta_phone_number_id
  on public.psicologos (meta_phone_number_id)
  where meta_phone_number_id is not null;

create table if not exists public.mensajes_procesados (
  wamid text primary key,
  status text not null default 'processing' check (status in ('processing', 'completed', 'failed', 'delivery_uncertain')),
  processing_started_at timestamptz,
  processed_at timestamptz,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_mensajes_procesados_status
  on public.mensajes_procesados (status, processing_started_at);

alter table public.mensajes_procesados enable row level security;

-- Remove all client-role grants. The Edge Function uses the service role server-side.
revoke all on table public.psicologos from public, anon, authenticated;
revoke all on table public.conversaciones from public, anon, authenticated;
revoke all on table public.mensajes_procesados from public, anon, authenticated;

-- Remove the Phase 1 public policies from the original migrations.
drop policy if exists "Public read access on psicologos" on public.psicologos;
drop policy if exists "Service role full access" on public.conversaciones;
drop policy if exists "Anon read access on conversaciones" on public.conversaciones;

comment on table public.mensajes_procesados is
  'Durable Phase 1 idempotency state keyed by Meta wamid; service-role only.';
comment on column public.psicologos.meta_phone_number_id is
  'Meta phone_number_id from inbound webhook metadata; nullable during Phase 1 seed setup.';
comment on column public.psicologos.horarios is
  'Optional availability text. It is intentionally not seeded until product data is defined.';
