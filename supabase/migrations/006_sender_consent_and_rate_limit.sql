-- 006: per-sender opt-in consent records and per-window rate-limit counters.
--
-- WHY THESE TABLES EXIST
-- The business number answers any sender that reaches it, so before this migration
-- every unknown number drove the full pipeline: getBoundedHistory read stored
-- history, processIncomingMessage may have called Claude, and both sides of the
-- exchange were appended to conversaciones. That is unbounded cost per sender and
-- transcript retention with no consent record, which docs/02-usuarios.md:29 already
-- flags as indefensible for a stranger even though it is tolerable for a patient.
--
-- This migration is additive. No existing column, table, constraint, or grant is
-- removed or weakened. RLS stays enabled on both new tables and NO policy is added:
-- every read and write is issued by the Edge Function with the service role, which
-- bypasses RLS, and migration 004 already revoked every client grant on the tables
-- that existed at the time. These two tables adopt the same posture.
--
-- Neither table is read by anything except supabase/functions/_shared/gate.ts and
-- the data-access helpers in supabase/functions/_shared/supabase.ts, so the schema
-- is shaped around exactly those two call sites and nothing else.

begin;

-- 1. Consent, one row per (psicologo_id, numero_remitente).
--
-- The unique constraint below is declared INLINE rather than as a bare unique index
-- on purpose: PostgREST builds "ON CONFLICT ... DO UPDATE SET" only against a real
-- constraint, so recordSenderConsent could not perform its idempotent upsert against
-- a plain index. This is the same requirement migration 005 had to satisfy for
-- conversaciones, and the reason it declares a constraint and not an index.
--
-- Revoking consent is a DELETE of the row; no boolean column is needed because the
-- absence of a row is the absence of consent.
create table if not exists public.sender_consents (
  psicologo_id uuid references public.psicologos(id) on delete cascade not null,
  numero_remitente text not null,
  opted_in_at timestamptz not null default now(),
  origen text not null default 'whatsapp_optin',
  created_at timestamptz not null default now(),
  constraint sender_consents_psicologo_id_numero_remitente_key
    unique (psicologo_id, numero_remitente)
);

comment on table public.sender_consents is
  'Explicit opt-in consent from a WhatsApp sender, scoped per psychologist. A row means the sender agreed to receive open-ended answers and to have this conversation stored; absence of a row means no consent. Revocation is a DELETE of the row.';
comment on column public.sender_consents.numero_remitente is
  'Sender number in the same normalized E.164 form used by conversaciones.numero_paciente, so one normalization covers both tables.';
comment on column public.sender_consents.opted_in_at is
  'When consent was first granted for this sender. recordSenderConsent deliberately omits this column from its upsert payload, so re-sending an opt-in token does not restate the original consent time.';
comment on column public.sender_consents.origen is
  'How consent was captured. Defaults to the WhatsApp opt-in flow that gate.ts serves.';

-- 2. Rate-limit counters, one row per (psicologo_id, numero_remitente, window_started_at).
--
-- window_started_at is the floor of a fixed window (see RATE_LIMIT_WINDOW_MS in
-- supabase/functions/_shared/gate.ts), never "now". Flooring is what lets the
-- increment be a single atomic statement: the primary key is the bucket identity, so
-- two concurrent webhooks for the same sender in the same window contend for one row
-- and serialize on it instead of each inserting their own bucket.
create table if not exists public.sender_rate_buckets (
  psicologo_id uuid references public.psicologos(id) on delete cascade not null,
  numero_remitente text not null,
  window_started_at timestamptz not null,
  message_count integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (psicologo_id, numero_remitente, window_started_at)
);

comment on table public.sender_rate_buckets is
  'Per-sender message counters for a fixed-window rate limit, one row per (psicologo_id, numero_remitente, window_started_at). Rows older than the retention horizon may be deleted opportunistically; nothing reads them, because the gate only ever compares the count in the current window.';
comment on column public.sender_rate_buckets.window_started_at is
  'Start of the fixed window this counter belongs to, floored to the window boundary. The ceiling is applied against the current window only, so an expired window never blocks a sender.';
comment on column public.sender_rate_buckets.message_count is
  'Messages attributed to this sender in this window. Incremented by consume_sender_rate_limit_slot, never computed in application code.';

-- 3. The atomic increment.
--
-- WHY A FUNCTION INSTEAD OF A PLAIN POSTGREST UPSERT
-- consumeRateLimitSlot must increment the counter, not overwrite it. PostgREST builds
-- "ON CONFLICT ... DO UPDATE SET" exclusively from the columns present in the request
-- payload, so a supabase-js upsert of { message_count: 1 } against the primary key
-- performs a blind set: every call in the same window writes 1 back, the count can
-- never exceed 1, and the ceiling is therefore never reached. PostgREST has no
-- arithmetic form, so no payload can express "existing + 1".
--
-- This function is the smallest correct expression of that increment. The whole
-- counter update is one "INSERT ... ON CONFLICT DO UPDATE ... RETURNING" statement, so
-- the read-modify-write happens under the row lock Postgres already takes for the
-- conflict and two concurrent webhooks cannot both observe the same pre-increment
-- value. It is the same single-statement guarantee getOrCreateConversacion relies on
-- for the constraint created by migration 005.
--
-- SECURITY DEFINER is deliberate: the client roles hold no grant on this table (see
-- the revoke below), so the function must not depend on the caller's grants, and
-- search_path is pinned to empty with fully qualified references so the body cannot be
-- redirected through a caller-controlled schema. EXECUTE is revoked from every client
-- role below; only the service role that migration 004 left able to write can call it.
create or replace function public.consume_sender_rate_limit_slot(
  p_psicologo_id uuid,
  p_numero_remitente text,
  p_window_started_at timestamptz
) returns integer
language sql
security definer
set search_path = ''
as $$
  insert into public.sender_rate_buckets as bucket (
    psicologo_id,
    numero_remitente,
    window_started_at,
    message_count
  )
  values (
    p_psicologo_id,
    p_numero_remitente,
    p_window_started_at,
    1
  )
  on conflict (psicologo_id, numero_remitente, window_started_at)
  do update
    set message_count = bucket.message_count + 1,
        updated_at = now()
  returning message_count;
$$;

comment on function public.consume_sender_rate_limit_slot is
  'Consumes one rate-limit slot for a sender window and returns the resulting count. One atomic statement, so concurrent webhooks cannot both consume the same slot. Depends on the primary key of public.sender_rate_buckets and must exist before the Edge Function is deployed.';

-- 4. RLS with no policies, matching the posture migrations 004 and 005 established:
--    the Edge Function reads and writes through the service role, and no client role
--    can reach these tables at all.
alter table public.sender_consents enable row level security;
alter table public.sender_rate_buckets enable row level security;

-- 5. Remove all client-role grants, as migration 004 did for every table it found.
--    RLS alone would be enough against anon and authenticated, but revoking the grant
--    also removes the ability to even attempt the read.
revoke all on table public.sender_consents from public, anon, authenticated;
revoke all on table public.sender_rate_buckets from public, anon, authenticated;

-- 6. The tables are created without policies on purpose, so there is nothing of the
--    pre-existing policy posture to remove here. These guarded drops keep the
--    migration re-runnable for an installation where a policy was ever attached
--    manually, and are no-ops on a clean database.
drop policy if exists "Service role full access" on public.sender_consents;
drop policy if exists "Service role full access" on public.sender_rate_buckets;
drop policy if exists "Anon read access on sender_consents" on public.sender_consents;
drop policy if exists "Anon read access on sender_rate_buckets" on public.sender_rate_buckets;

-- 7. Only the service role may execute the increment function.
--
--    PostgreSQL grants EXECUTE on a new function to PUBLIC by default, so the revoke
--    below is what actually closes the function to anon and authenticated. It is also
--    why the explicit grant that follows is not optional: revoking from PUBLIC removes
--    the ONLY privilege service_role ever held on this function, because it was never
--    granted one directly. Without the grant back, the Edge Function's service-role
--    call would fail with "permission denied for function", and because
--    consumeRateLimitSlot swallows that error into a null, the failure would be silent
--    and would only surface as a rate limit that never counts anything.
revoke all on function public.consume_sender_rate_limit_slot(uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.consume_sender_rate_limit_slot(uuid, text, timestamptz)
  to service_role;

commit;