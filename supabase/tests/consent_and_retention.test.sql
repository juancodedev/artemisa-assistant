-- Database tests for migrations 007 and 008.
--
-- Run against a disposable database that has every migration applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/consent_and_retention.test.sql
-- Every check raises on failure, and the whole run is rolled back, so it leaves no data.
-- See docs/09-privacidad-y-consentimiento.md for a local Postgres recipe.

begin;

-- Fixtures. The policies are published in the past so the checks never depend on now().
insert into public.psicologos (id, nombre, numero_whatsapp, modalidad, direccion, precio, tipo_de_cita, link_calcom)
values ('00000000-0000-0000-0000-0000000000a1', 'Test', '+56900000001', 'Online', 'Calle 1', '$1', 'Sesión', 'https://cal.com/test');

insert into public.consent_policies (version, texto, politica_url, vigente_desde)
values ('test-v1', 'Texto v1. Responde ACEPTO.', 'https://example.test/v1', now() - interval '2 days');

set local role service_role;

-- No consent and no prompt yet: the active policy is reported as not consented.
do $$
declare state record;
begin
  select * into state from public.get_sender_consent_state('00000000-0000-0000-0000-0000000000a1', '+111');
  if state.policy_version is distinct from 'test-v1' then raise exception 'active policy not reported: %', state.policy_version; end if;
  if state.consented or state.prompt_shown then raise exception 'fresh sender reported as consented or prompted'; end if;
end $$;

-- Prompt shown, then granted: consented to the active version.
insert into public.consent_prompts (psicologo_id, numero_remitente, policy_version, wamid)
values ('00000000-0000-0000-0000-0000000000a1', '+111', 'test-v1', 'wamid-prompt');
insert into public.consent_events (psicologo_id, numero_remitente, evento, policy_version, wamid, origen)
values ('00000000-0000-0000-0000-0000000000a1', '+111', 'granted', 'test-v1', 'wamid-grant', 'whatsapp_acepto');

do $$
declare state record;
begin
  select * into state from public.get_sender_consent_state('00000000-0000-0000-0000-0000000000a1', '+111');
  if not state.consented or not state.prompt_shown then raise exception 'granted sender not reported as consented'; end if;
  -- Consent is per sender: another number is not consented.
  select * into state from public.get_sender_consent_state('00000000-0000-0000-0000-0000000000a1', '+222');
  if state.consented then raise exception 'consent leaked to another sender'; end if;
end $$;

-- The log is append-only, even for the service role.
do $$
begin
  begin
    update public.consent_events set origen = 'tampered';
    raise exception 'consent_events accepted an UPDATE';
  exception when insufficient_privilege or raise_exception then
    if sqlerrm = 'consent_events accepted an UPDATE' then raise; end if;
  end;
  begin
    delete from public.consent_events;
    raise exception 'consent_events accepted a DELETE';
  exception when insufficient_privilege or raise_exception then
    if sqlerrm = 'consent_events accepted a DELETE' then raise; end if;
  end;
end $$;

reset role;

-- The trigger also stops a role that holds every privilege.
do $$
begin
  begin
    delete from public.consent_events;
    raise exception 'owner could delete consent_events';
  exception when raise_exception then
    if sqlerrm <> 'consent_events is append-only' then raise; end if;
  end;
  begin
    truncate public.consent_events;
    raise exception 'owner could truncate consent_events';
  exception when raise_exception then
    if sqlerrm <> 'consent_events is append-only' then raise; end if;
  end;
end $$;

-- A published policy is frozen; a draft is not; a published policy needs a link.
do $$
begin
  begin
    update public.consent_policies set texto = 'otro' where version = 'test-v1';
    raise exception 'published policy was edited';
  exception when raise_exception then
    if sqlerrm <> 'consent policy test-v1 is published and cannot be changed' then raise; end if;
  end;
  update public.consent_policies set texto = texto || ' ' where version = '2026-11-borrador';
  begin
    insert into public.consent_policies (version, texto, vigente_desde) values ('sin-url', 'x', now());
    raise exception 'policy published without a link';
  exception when check_violation then null;
  end;
end $$;

-- A newer published policy asks again: the earlier grant no longer counts.
insert into public.consent_policies (version, texto, politica_url, vigente_desde)
values ('test-v2', 'Texto v2. Responde ACEPTO.', 'https://example.test/v2', now() - interval '1 day');

do $$
declare state record;
begin
  select * into state from public.get_sender_consent_state('00000000-0000-0000-0000-0000000000a1', '+111');
  if state.policy_version <> 'test-v2' then raise exception 'newer policy not active: %', state.policy_version; end if;
  if state.consented or state.prompt_shown then raise exception 'grant of an older policy counted for the new one'; end if;
end $$;

-- A future policy is not active yet.
insert into public.consent_policies (version, texto, politica_url, vigente_desde)
values ('test-future', 'Futuro', 'https://example.test/f', now() + interval '1 day');

do $$
declare state record;
begin
  select * into state from public.get_sender_consent_state('00000000-0000-0000-0000-0000000000a1', '+111');
  if state.policy_version <> 'test-v2' then raise exception 'future policy became active'; end if;
end $$;

-- Revoking: the latest event decides.
insert into public.consent_events (psicologo_id, numero_remitente, evento, policy_version, wamid, origen)
values ('00000000-0000-0000-0000-0000000000a1', '+333', 'granted', 'test-v2', 'w1', 'whatsapp_acepto'),
       ('00000000-0000-0000-0000-0000000000a1', '+333', 'revoked', 'test-v2', 'w2', 'whatsapp_baja');

do $$
declare state record;
begin
  select * into state from public.get_sender_consent_state('00000000-0000-0000-0000-0000000000a1', '+333');
  if state.consented then raise exception 'revoked sender still consented'; end if;
end $$;

-- No client role can read or call any of it.
do $$
begin
  if has_table_privilege('anon', 'public.consent_events', 'select')
    or has_table_privilege('authenticated', 'public.consent_events', 'select')
    or has_table_privilege('anon', 'public.consent_prompts', 'select')
    or has_table_privilege('anon', 'public.consent_policies', 'select')
    or has_function_privilege('anon', 'public.get_sender_consent_state(uuid, text)', 'execute')
    or has_function_privilege('authenticated', 'public.get_sender_consent_state(uuid, text)', 'execute')
  then
    raise exception 'a client role can reach consent data';
  end if;
end $$;

-- 008: BAJA appends a revocation only when there is a consent to withdraw.
set local role service_role;

insert into public.consent_events (psicologo_id, numero_remitente, evento, policy_version, wamid, origen)
values ('00000000-0000-0000-0000-0000000000a1', '+444', 'granted', 'test-v2', 'w-grant-444', 'whatsapp_acepto');

do $$
declare state record;
begin
  if not public.revoke_sender_consent('00000000-0000-0000-0000-0000000000a1', '+444', 'w-baja-444') then
    raise exception 'BAJA did not withdraw an existing consent';
  end if;
  -- A second BAJA has nothing left to withdraw and appends nothing.
  if public.revoke_sender_consent('00000000-0000-0000-0000-0000000000a1', '+444', 'w-baja-444-bis') then
    raise exception 'BAJA withdrew a consent twice';
  end if;
  if (select count(*) from public.consent_events where numero_remitente = '+444') <> 2 then
    raise exception 'BAJA appended the wrong number of events';
  end if;
  if exists (
    select 1 from public.consent_events
    where numero_remitente = '+444' and evento = 'revoked'
      and (policy_version <> 'test-v2' or wamid <> 'w-baja-444' or origen <> 'whatsapp_baja')
  ) then
    raise exception 'revocation did not record the withdrawn version, message and origin';
  end if;
  select * into state from public.get_sender_consent_state('00000000-0000-0000-0000-0000000000a1', '+444');
  if state.consented then raise exception 'sender still consented after BAJA'; end if;
  -- An unknown sender has nothing to withdraw.
  if public.revoke_sender_consent('00000000-0000-0000-0000-0000000000a1', '+999', 'w') then
    raise exception 'BAJA withdrew a consent that never existed';
  end if;
end $$;

reset role;

-- 008: ELIMINAR erases the sender's data for this psychologist only, keeps the log.
insert into public.psicologos (id, nombre, numero_whatsapp, modalidad, direccion, precio, tipo_de_cita, link_calcom)
values ('00000000-0000-0000-0000-0000000000a2', 'Otro', '+56900000002', 'Online', 'Calle 2', '$2', 'Sesión', 'https://cal.com/otro');

insert into public.conversaciones (psicologo_id, numero_paciente, historial)
values ('00000000-0000-0000-0000-0000000000a1', '+555', '[]'::jsonb),
       ('00000000-0000-0000-0000-0000000000a2', '+555', '[]'::jsonb),
       ('00000000-0000-0000-0000-0000000000a1', '+666', '[]'::jsonb);
insert into public.consent_prompts (psicologo_id, numero_remitente, policy_version, wamid)
values ('00000000-0000-0000-0000-0000000000a1', '+555', 'test-v2', 'w-prompt-555');
insert into public.consent_events (psicologo_id, numero_remitente, evento, policy_version, wamid, origen)
values ('00000000-0000-0000-0000-0000000000a1', '+555', 'granted', 'test-v2', 'w-grant-555', 'whatsapp_acepto');
insert into public.sender_rate_buckets (psicologo_id, numero_remitente, window_started_at, message_count)
values ('00000000-0000-0000-0000-0000000000a1', '+555', date_trunc('hour', now()), 3),
       ('00000000-0000-0000-0000-0000000000a1', '+555', date_trunc('hour', now()) - interval '3 hours', 2);
insert into public.sender_consents (psicologo_id, numero_remitente)
values ('00000000-0000-0000-0000-0000000000a1', '+555');

set local role service_role;

do $$
begin
  if not public.erase_sender_data('00000000-0000-0000-0000-0000000000a1', '+555', 'w-eliminar-555') then
    raise exception 'ELIMINAR did not report the withdrawn consent';
  end if;
end $$;

reset role;

do $$
begin
  if exists (select 1 from public.conversaciones where psicologo_id = '00000000-0000-0000-0000-0000000000a1' and numero_paciente = '+555')
    or exists (select 1 from public.consent_prompts where numero_remitente = '+555')
    or exists (select 1 from public.sender_rate_buckets where numero_remitente = '+555' and window_started_at < now() - interval '2 hours')
    or exists (select 1 from public.sender_consents where numero_remitente = '+555')
  then
    raise exception 'ELIMINAR left personal data behind';
  end if;
  -- The current counter is kept, so ELIMINAR cannot reset the rate limit.
  if not exists (select 1 from public.sender_rate_buckets where numero_remitente = '+555' and window_started_at = date_trunc('hour', now())) then
    raise exception 'ELIMINAR reset the current rate-limit counter';
  end if;
  -- Other psychologists and other senders are untouched.
  if (select count(*) from public.conversaciones where numero_paciente = '+555') <> 1
    or (select count(*) from public.conversaciones where numero_paciente = '+666') <> 1
  then
    raise exception 'ELIMINAR erased data of another psychologist or sender';
  end if;
  -- The proof is kept: the grant and the withdrawal.
  if (select string_agg(evento || ':' || origen, ',' order by id) from public.consent_events where numero_remitente = '+555')
    <> 'granted:whatsapp_acepto,revoked:whatsapp_eliminar'
  then
    raise exception 'ELIMINAR did not keep the consent log';
  end if;
end $$;

-- 008: the purge deletes only what is older than the retention, never the log.
insert into public.conversaciones (psicologo_id, numero_paciente, historial, ultima_actividad)
values ('00000000-0000-0000-0000-0000000000a1', '+777', '[]'::jsonb, now() - interval '91 days'),
       ('00000000-0000-0000-0000-0000000000a1', '+888', '[]'::jsonb, now() - interval '89 days');
insert into public.consent_prompts (psicologo_id, numero_remitente, policy_version, wamid, shown_at)
values ('00000000-0000-0000-0000-0000000000a1', '+777', 'test-v2', 'w-old', now() - interval '91 days');
insert into public.mensajes_procesados (wamid, status, created_at)
values ('w-processed-old', 'completed', now() - interval '91 days'),
       ('w-processed-new', 'completed', now());
insert into public.sender_rate_buckets (psicologo_id, numero_remitente, window_started_at, message_count)
values ('00000000-0000-0000-0000-0000000000a1', '+777', now() - interval '2 days', 1);

set local role service_role;

do $$
declare
  purged record;
  events_before bigint := (select count(*) from public.consent_events);
begin
  select * into purged from public.purge_expired_personal_data(interval '90 days');
  if purged.conversaciones <> 1 or purged.consent_prompts <> 1
    or purged.mensajes_procesados <> 1 or purged.sender_rate_buckets <> 1
  then
    raise exception 'purge counts wrong: %', purged;
  end if;
  if (select count(*) from public.consent_events) <> events_before then
    raise exception 'purge touched the consent log';
  end if;
  begin
    perform public.purge_expired_personal_data(interval '1 hour');
    raise exception 'purge accepted a retention shorter than a day';
  exception when invalid_parameter_value then null;
  end;
end $$;

reset role;

-- Checked as the owner: on plain Postgres the service role holds no grant on these.
do $$
begin
  if exists (select 1 from public.conversaciones where numero_paciente = '+777') then
    raise exception 'expired conversation survived the purge';
  end if;
  if not exists (select 1 from public.conversaciones where numero_paciente = '+888') then
    raise exception 'purge deleted a conversation inside the retention';
  end if;
  if not exists (select 1 from public.mensajes_procesados where wamid = 'w-processed-new') then
    raise exception 'purge deleted a recent idempotency row';
  end if;
end $$;

-- 008: the service role cannot write policies, and no client role reaches the functions.
do $$
begin
  if has_table_privilege('service_role', 'public.consent_policies', 'insert')
    or has_table_privilege('service_role', 'public.consent_policies', 'update')
    or has_table_privilege('service_role', 'public.consent_policies', 'delete')
  then
    raise exception 'service role can write consent policies';
  end if;
  if has_function_privilege('anon', 'public.erase_sender_data(uuid, text, text)', 'execute')
    or has_function_privilege('authenticated', 'public.erase_sender_data(uuid, text, text)', 'execute')
    or has_function_privilege('anon', 'public.revoke_sender_consent(uuid, text, text, text)', 'execute')
    or has_function_privilege('anon', 'public.purge_expired_personal_data(interval)', 'execute')
  then
    raise exception 'a client role can call a rights or retention function';
  end if;
end $$;

rollback;
