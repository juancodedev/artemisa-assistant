-- 008: sender rights over WhatsApp (BAJA, ELIMINAR) and time-based retention.
--
-- WHY
-- The consent text of migration 007 promises three things: BAJA withdraws consent,
-- ELIMINAR erases the history, and conversations are deleted after 90 days without
-- activity. This migration provides the database side of all three.
--
-- WHAT IS KEPT
-- consent_events is never touched: it is the proof of what was granted and withdrawn,
-- and the consent text says it is kept. Everything else that holds a sender's number
-- or messages is deletable.
--
-- SCHEDULING
-- This migration does NOT schedule the purge. The first run deletes real conversations
-- and cannot be undone, so it is a deliberate operator step:
-- supabase/scripts/schedule_retention_purge.sql and docs/09-privacidad-y-consentimiento.md.
--
-- SECURITY DEFINER, as consume_sender_rate_limit_slot in 006: these functions delete
-- across several tables, so they must not depend on the caller's table grants. The
-- search_path is empty so no name can be redirected, and EXECUTE is granted to the
-- service role only.

begin;

-- 0. consent_policies is read-only for the service role. Supabase default privileges
--    may grant it more, so the write privileges are revoked explicitly, as 007 did
--    for consent_events. Policies are published by an operator, never through the API.
revoke insert, update, delete, truncate on table public.consent_policies from service_role;

-- 1. BAJA: append a revoked event when the sender's latest event is a grant.
--    Returns true when a consent was withdrawn, false when there was none.
--    The advisory lock serializes concurrent BAJA and ELIMINAR for the same sender,
--    so two messages cannot both append a revocation.
create or replace function public.revoke_sender_consent(
  p_psicologo_id uuid,
  p_numero_remitente text,
  p_wamid text,
  p_origen text default 'whatsapp_baja'
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  latest record;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_psicologo_id::text || '|' || p_numero_remitente, 0)
  );

  select event.evento, event.policy_version
  into latest
  from public.consent_events as event
  where event.psicologo_id = p_psicologo_id
    and event.numero_remitente = p_numero_remitente
  order by event.id desc
  limit 1;

  if not found or latest.evento <> 'granted' then
    return false;
  end if;

  insert into public.consent_events (
    psicologo_id, numero_remitente, evento, policy_version, wamid, origen
  ) values (
    p_psicologo_id, p_numero_remitente, 'revoked', latest.policy_version, p_wamid, p_origen
  );
  return true;
end;
$$;

comment on function public.revoke_sender_consent(uuid, text, text, text) is
  'Withdraws the sender''s current consent by appending a revoked event. Returns false when there was no consent to withdraw.';

-- 2. ELIMINAR: withdraw consent, then delete everything that holds this sender's
--    number or messages for this psychologist. consent_events is kept.
--    One transaction: either all of it is erased or none of it is.
create or replace function public.erase_sender_data(
  p_psicologo_id uuid,
  p_numero_remitente text,
  p_wamid text
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  revoked boolean;
begin
  revoked := public.revoke_sender_consent(
    p_psicologo_id, p_numero_remitente, p_wamid, 'whatsapp_eliminar'
  );

  delete from public.conversaciones
  where psicologo_id = p_psicologo_id and numero_paciente = p_numero_remitente;

  delete from public.consent_prompts
  where psicologo_id = p_psicologo_id and numero_remitente = p_numero_remitente;

  -- Counters from the last two hours are kept: erasing them would reset the rate limit
  -- and let a sender cycle ELIMINAR and ACEPTO past it. The purge removes them within
  -- a day.
  delete from public.sender_rate_buckets
  where psicologo_id = p_psicologo_id and numero_remitente = p_numero_remitente
    and window_started_at < pg_catalog.now() - interval '2 hours';

  -- Legacy consents from migration 006, no longer read but still personal data.
  delete from public.sender_consents
  where psicologo_id = p_psicologo_id and numero_remitente = p_numero_remitente;

  return revoked;
end;
$$;

comment on function public.erase_sender_data(uuid, text, text) is
  'Withdraws consent and deletes the sender''s conversation, consent prompts, rate counters older than two hours and legacy consent. The consent log is kept as proof.';

-- 3. Retention purge. Deletes personal data older than p_retention:
--    - conversations without activity in that time;
--    - consent prompts shown that long ago (a returning sender is simply shown the
--      text again);
--    - idempotency rows (they hold only message ids, kept no longer than needed).
--    Rate counters are only useful within their hour, so any older than a day go.
--    Returns how many rows each table lost, for the job log.
create or replace function public.purge_expired_personal_data(
  p_retention interval default interval '90 days'
) returns table (
  conversaciones bigint,
  consent_prompts bigint,
  mensajes_procesados bigint,
  sender_rate_buckets bigint
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  cutoff timestamptz;
begin
  -- A short retention would erase live conversations, so it is refused outright.
  if p_retention is null or p_retention < interval '1 day' then
    raise exception 'retention must be at least 1 day, got %', p_retention
      using errcode = '22023';
  end if;
  cutoff := pg_catalog.now() - p_retention;

  with deleted as (
    delete from public.conversaciones as conversation
    where coalesce(conversation.ultima_actividad, conversation.updated_at, conversation.created_at) < cutoff
    returning 1
  ) select count(*) into conversaciones from deleted;

  with deleted as (
    delete from public.consent_prompts as prompt
    where prompt.shown_at < cutoff
    returning 1
  ) select count(*) into consent_prompts from deleted;

  with deleted as (
    delete from public.mensajes_procesados as processed
    where processed.created_at < cutoff
    returning 1
  ) select count(*) into mensajes_procesados from deleted;

  with deleted as (
    delete from public.sender_rate_buckets as bucket
    where bucket.window_started_at < pg_catalog.now() - interval '1 day'
    returning 1
  ) select count(*) into sender_rate_buckets from deleted;

  return next;
end;
$$;

comment on function public.purge_expired_personal_data(interval) is
  'Deletes conversations, consent prompts and idempotency rows older than the retention, and rate counters older than a day. Never touches consent_events. Scheduled by supabase/scripts/schedule_retention_purge.sql.';

-- 4. Access: service role only.
revoke all on function public.revoke_sender_consent(uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.erase_sender_data(uuid, text, text) from public, anon, authenticated;
revoke all on function public.purge_expired_personal_data(interval) from public, anon, authenticated;
grant execute on function public.revoke_sender_consent(uuid, text, text, text) to service_role;
grant execute on function public.erase_sender_data(uuid, text, text) to service_role;
grant execute on function public.purge_expired_personal_data(interval) to service_role;

commit;
