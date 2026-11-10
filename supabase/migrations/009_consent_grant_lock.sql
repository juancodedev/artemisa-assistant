-- 009: ACEPTO takes the same per-sender lock as BAJA and ELIMINAR.
--
-- WHY
-- Migration 008 serializes BAJA and ELIMINAR for one sender with an advisory lock, but
-- ACEPTO was a plain INSERT into consent_events from the Edge Function. If ELIMINAR and
-- ACEPTO from the same sender interleaved, a granted event could land after the
-- erasure, on a prompt that ELIMINAR had just deleted.
--
-- WHAT CHANGES
-- 1. record_sender_consent: takes the lock, then appends the grant only when the text
--    of that policy version is still recorded as shown. After ELIMINAR it is not, so
--    the grant is refused and the sender is shown the text again.
-- 2. The service role loses INSERT on consent_events. Every write to the log now goes
--    through a function that takes the lock, so the lock cannot be bypassed.
-- 3. erase_sender_data keeps the counter of the current rate-limit window, passed by the
--    Edge Function, instead of a two-hour literal that silently assumed a one-hour
--    window. The old three-argument signature is dropped so a call cannot be ambiguous.
-- 4. Supabase default privileges grant anon and authenticated ALL on the sequence of
--    consent_events. They cannot insert into the table, but the grant is revoked anyway.
-- 5. A published policy must name ACEPTO, BAJA and ELIMINAR, the words the bot acts on.
--
-- DEPLOY ORDER
-- Apply this migration, then deploy the webhook right away. Until the new webhook is
-- live, ACEPTO and ELIMINAR fail with an honest "could not process" reply.

begin;

-- 1. ACEPTO.
create or replace function public.record_sender_consent(
  p_psicologo_id uuid,
  p_numero_remitente text,
  p_policy_version text,
  p_wamid text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Same key as revoke_sender_consent and erase_sender_data (migration 008).
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_psicologo_id::text || '|' || p_numero_remitente, 0)
  );

  -- Consent to a text nobody saw is not informed. Under the lock, this also sees an
  -- ELIMINAR that committed first, since it deletes the prompt.
  if not exists (
    select 1
    from public.consent_prompts as prompt
    where prompt.psicologo_id = p_psicologo_id
      and prompt.numero_remitente = p_numero_remitente
      and prompt.policy_version = p_policy_version
  ) then
    return false;
  end if;

  insert into public.consent_events (
    psicologo_id, numero_remitente, evento, policy_version, wamid, origen
  ) values (
    p_psicologo_id, p_numero_remitente, 'granted', p_policy_version, p_wamid, 'whatsapp_acepto'
  );
  return true;
end;
$$;

comment on function public.record_sender_consent(uuid, text, text, text) is
  'ACEPTO: appends a granted event under the per-sender lock, only when the text of that policy version was shown. Returns false when it was not.';

-- 2. The log is written only through the locked functions.
revoke insert on table public.consent_events from service_role;

-- 3. ELIMINAR keeps the current rate-limit window, whatever its length.
drop function if exists public.erase_sender_data(uuid, text, text);

create function public.erase_sender_data(
  p_psicologo_id uuid,
  p_numero_remitente text,
  p_wamid text,
  p_rate_window_started_at timestamptz
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked boolean;
begin
  if p_rate_window_started_at is null then
    raise exception 'the current rate-limit window is required' using errcode = '22023';
  end if;

  revoked := public.revoke_sender_consent(
    p_psicologo_id, p_numero_remitente, p_wamid, 'whatsapp_eliminar'
  );

  delete from public.conversaciones
  where psicologo_id = p_psicologo_id and numero_paciente = p_numero_remitente;

  delete from public.consent_prompts
  where psicologo_id = p_psicologo_id and numero_remitente = p_numero_remitente;

  -- The counter of the current window is kept: erasing it would reset the rate limit
  -- and let a sender cycle ELIMINAR and ACEPTO past it. The purge removes it within a
  -- day.
  delete from public.sender_rate_buckets
  where psicologo_id = p_psicologo_id and numero_remitente = p_numero_remitente
    and window_started_at < p_rate_window_started_at;

  -- Legacy consents from migration 006, no longer read but still personal data.
  delete from public.sender_consents
  where psicologo_id = p_psicologo_id and numero_remitente = p_numero_remitente;

  return revoked;
end;
$$;

comment on function public.erase_sender_data(uuid, text, text, timestamptz) is
  'Withdraws consent and deletes the sender''s conversation, consent prompts, rate counters before the current window and legacy consent. The consent log is kept as proof.';

-- 4. Access.
revoke all on function public.record_sender_consent(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.erase_sender_data(uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_sender_consent(uuid, text, text, text) to service_role;
grant execute on function public.erase_sender_data(uuid, text, text, timestamptz) to service_role;

revoke all on sequence public.consent_events_id_seq from public, anon, authenticated;

-- 5. A published policy names the words the bot acts on. Drafts are not checked, so a
--    text under review can still be edited freely.
alter table public.consent_policies
  add constraint consent_policies_published_names_commands
  check (
    vigente_desde is null
    or (texto like '%ACEPTO%' and texto like '%BAJA%' and texto like '%ELIMINAR%')
  );

commit;
