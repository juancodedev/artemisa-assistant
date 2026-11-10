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

rollback;
