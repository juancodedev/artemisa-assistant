-- 007: versioned consent policies and an append-only consent log.
--
-- WHY
-- Migration 006 stored one row per consenting sender and nothing else: not which text
-- the sender saw, not which policy they accepted, and revoking was a DELETE that
-- erased the only proof. Before Artemisa is offered to a health center, consent has to
-- be informed (the sender saw a specific text), versioned (a new policy asks again),
-- and provable (the record of granting and revoking is never rewritten).
--
-- SHAPE
-- - consent_policies: one row per policy version. A row with vigente_desde NULL is a
--   draft and may be edited; once published it is frozen, because it is the proof of
--   what a sender accepted. The active policy is the published row with the latest
--   vigente_desde that is not in the future.
-- - consent_prompts: which policy text was shown to which sender. It is ordinary,
--   deletable state: it holds numbers of people who never consented, so it is erased
--   with the rest of their data (migration 008).
-- - consent_events: the append-only log of granted and revoked consents. UPDATE,
--   DELETE and TRUNCATE are rejected by trigger.
--
-- MIGRATION OF EXISTING CONSENTS
-- None, on purpose. Rows in sender_consents accepted a text that named no controller,
-- processors, retention or rights, so those senders are asked again under the new
-- policy. The table is left untouched and is no longer read by the Edge Function.
--
-- ROLLOUT
-- The policy below is seeded as a DRAFT. With no published policy nobody can consent
-- and the bot answers only deterministic listing questions, so applying this migration
-- before the legal text is approved is safe but pauses open answers for everyone.
-- Publishing is a separate, deliberate step (docs/09-privacidad-y-consentimiento.md).
--
-- All access is through the service role from the Edge Function, as in 004 and 006.

begin;

-- 1. Policy versions.
create table if not exists public.consent_policies (
  version text primary key,
  texto text not null,
  politica_url text,
  vigente_desde timestamptz,
  created_at timestamptz not null default now(),
  -- A sender must be able to read the full policy, so it cannot go live without a link.
  constraint consent_policies_published_needs_url
    check (vigente_desde is null or politica_url is not null)
);

comment on table public.consent_policies is
  'Consent policy versions. vigente_desde NULL is a draft; a published row is frozen by trigger because it is the proof of what a sender accepted.';
comment on column public.consent_policies.texto is
  'Exact consent text sent over WhatsApp. {profesional} is replaced with the psychologist''s name when it is rendered.';

create or replace function public.protect_published_consent_policy()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.vigente_desde is not null then
    raise exception 'consent policy % is published and cannot be changed', old.version
      using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_published_consent_policy on public.consent_policies;
create trigger protect_published_consent_policy
  before update or delete on public.consent_policies
  for each row execute function public.protect_published_consent_policy();

-- 2. Which policy text each sender was shown.
create table if not exists public.consent_prompts (
  psicologo_id uuid not null references public.psicologos(id) on delete cascade,
  numero_remitente text not null,
  policy_version text not null references public.consent_policies(version),
  wamid text not null,
  shown_at timestamptz not null default now(),
  primary key (psicologo_id, numero_remitente, policy_version)
);

comment on table public.consent_prompts is
  'The consent text of a policy version was sent to this sender. ACEPTO is only honored after it. Deletable state, erased with the sender''s data.';

-- 3. The append-only consent log.
--
-- psicologo_id has no ON DELETE CASCADE on purpose: a cascade would delete log rows,
-- which the trigger below forbids, so deleting a psychologist with consent history
-- fails loudly instead of silently destroying the proof.
create table if not exists public.consent_events (
  id bigint generated always as identity primary key,
  psicologo_id uuid not null references public.psicologos(id),
  numero_remitente text not null,
  evento text not null check (evento in ('granted', 'revoked')),
  policy_version text not null references public.consent_policies(version),
  wamid text not null,
  origen text not null,
  created_at timestamptz not null default now()
);

comment on table public.consent_events is
  'Append-only log of consent granted and revoked per sender and psychologist. The latest event decides the current state; UPDATE, DELETE and TRUNCATE are rejected.';
comment on column public.consent_events.policy_version is
  'For granted, the version accepted. For revoked, the version of the grant being withdrawn.';
comment on column public.consent_events.wamid is
  'The WhatsApp message that carried the decision, so it can be traced to the original message.';

create index if not exists consent_events_sender_latest_idx
  on public.consent_events (psicologo_id, numero_remitente, id desc);

create or replace function public.reject_consent_event_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'consent_events is append-only' using errcode = 'P0001';
end;
$$;

drop trigger if exists consent_events_append_only on public.consent_events;
create trigger consent_events_append_only
  before update or delete on public.consent_events
  for each row execute function public.reject_consent_event_change();

drop trigger if exists consent_events_no_truncate on public.consent_events;
create trigger consent_events_no_truncate
  before truncate on public.consent_events
  for each statement execute function public.reject_consent_event_change();

-- 4. One round trip for the gate: the active policy, whether this sender consented to
--    THAT version, and whether its text was shown to them. Returns no row when no
--    policy is published, which the Edge Function reads as "nobody can consent".
--
--    SECURITY INVOKER: the service role holds the table grants below, so the function
--    needs no privileges of its own.
create or replace function public.get_sender_consent_state(
  p_psicologo_id uuid,
  p_numero_remitente text
) returns table (
  policy_version text,
  policy_texto text,
  politica_url text,
  consented boolean,
  prompt_shown boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with active_policy as (
    select policy.version, policy.texto, policy.politica_url
    from public.consent_policies as policy
    where policy.vigente_desde is not null
      and policy.vigente_desde <= now()
    order by policy.vigente_desde desc, policy.version desc
    limit 1
  ),
  latest_event as (
    select event.evento, event.policy_version
    from public.consent_events as event
    where event.psicologo_id = p_psicologo_id
      and event.numero_remitente = p_numero_remitente
    order by event.id desc
    limit 1
  )
  select
    active_policy.version,
    active_policy.texto,
    active_policy.politica_url,
    coalesce(
      (
        select latest_event.evento = 'granted'
          and latest_event.policy_version = active_policy.version
        from latest_event
      ),
      false
    ),
    exists (
      select 1
      from public.consent_prompts as prompt
      where prompt.psicologo_id = p_psicologo_id
        and prompt.numero_remitente = p_numero_remitente
        and prompt.policy_version = active_policy.version
    )
  from active_policy;
$$;

-- 5. Seed the first policy as a draft. Wording is a draft pending legal review.
insert into public.consent_policies (version, texto)
values (
  '2026-11-borrador',
  E'Antes de responder consultas abiertas o guardar esta conversación, necesito tu autorización.\n\n'
  || E'• Responsable: {profesional}.\n'
  || E'• Datos: tu número de WhatsApp y el contenido de tus mensajes, que pueden incluir información de salud.\n'
  || E'• Uso: responder consultas administrativas. No entrego diagnósticos ni orientación clínica.\n'
  || E'• Este canal es automático y nadie lo lee. Si estás en crisis, llama gratis al *4141.\n'
  || E'• Proveedores: Meta (WhatsApp), Anthropic (inteligencia artificial) y Supabase (almacenamiento) procesan estos datos, también fuera de Chile.\n'
  || E'• Conservación: la conversación se borra tras 90 días sin actividad. La constancia de tu autorización se conserva como respaldo.\n'
  || E'• Tus derechos: escribe BAJA para retirar tu autorización o ELIMINAR para borrar tu historial.\n\n'
  || E'Si estás de acuerdo, responde ACEPTO.'
)
on conflict (version) do nothing;

-- 6. Access: RLS on, no policies, no client grants, explicit service-role grants.
--    consent_events gets SELECT and INSERT only, so even the service role cannot
--    rewrite the log through the API; the trigger covers everyone else.
alter table public.consent_policies enable row level security;
alter table public.consent_prompts enable row level security;
alter table public.consent_events enable row level security;

revoke all on table public.consent_policies from public, anon, authenticated;
revoke all on table public.consent_prompts from public, anon, authenticated;
revoke all on table public.consent_events from public, anon, authenticated;

grant select on table public.consent_policies to service_role;
grant select, insert, update, delete on table public.consent_prompts to service_role;
revoke update, delete, truncate on table public.consent_events from service_role;
grant select, insert on table public.consent_events to service_role;

revoke all on function public.get_sender_consent_state(uuid, text) from public, anon, authenticated;
grant execute on function public.get_sender_consent_state(uuid, text) to service_role;

revoke all on function public.protect_published_consent_policy() from public, anon, authenticated;
revoke all on function public.reject_consent_event_change() from public, anon, authenticated;

commit;
