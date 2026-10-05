-- 005: guarantee exactly one conversation row per (psicologo_id, numero_paciente).
--
-- WHY THE DE-DUPLICATION STEP BELOW EXISTS
-- getOrCreateConversacion used to resolve a conversation with a non-atomic
-- read-then-write (a maybeSingle() read followed by a separate insert()).
-- Because conversaciones had no unique constraint on its logical key, two
-- concurrent deliveries of the same inbound message could both miss the read
-- and both insert, leaving duplicate rows for one logical conversation and
-- permanently splitting the patient history.
--
-- Step 2 repairs rows already split by that race before the constraint is added,
-- and MERGES the losing rows' historial into the survivor so no patient history
-- is discarded. getOrCreateConversacion now resolves the conversation with a
-- single ON CONFLICT upsert that depends on the constraint created in step 4,
-- so this migration MUST be applied BEFORE deploying the updated Edge Function
-- code: without the constraint the upsert fails with "no unique or exclusion
-- constraint matching the ON CONFLICT specification".
--
-- This migration is additive. No column, table, or grant is removed. RLS stays
-- enabled and no policy is added; all access remains service_role.
--
-- SURVIVOR TIE-BREAK ORDER (fully deterministic):
--   1. greatest updated_at  -- the most recently touched row wins
--   2. greatest created_at  -- the newest of the equally recently updated rows
--   3. lowest id            -- uuid ascending, stable last resort
-- NULL timestamps sort last in every comparison, so a row with an unknown
-- timestamp never wins over a row with a known one.

begin;

-- Pin the session GUCs the merge order depends on. A zone-less instant such as
-- '2024-03-01' denotes a different point under a different TimeZone, and
-- '03/01/2024' means March 1 under MDY but January 3 under DMY, so without this
-- the same rows can merge into a different historial on a different runner.
-- SET LOCAL reverts both at COMMIT, leaving the session as it was found.
set local datestyle = 'ISO, MDY';
set local timezone = 'UTC';

-- 0. The BEFORE UPDATE trigger created in migration 002 overwrites
--    new.updated_at with now() on every UPDATE, which would defeat the explicit
--    max(updated_at) merge in step 2. Suspend it for this transaction only, and
--    only if it actually exists, so the migration stays defensive and idempotent.
do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.conversaciones'::regclass
      and tgname = 'set_updated_at'
      and not tgisinternal
  ) then
    execute 'alter table public.conversaciones disable trigger set_updated_at';
  end if;
end
$$;

-- 1. Elect one survivor per logical conversation using the tie-break order above.
create temporary table conversation_dedup_survivors on commit drop as
select distinct on (c.psicologo_id, c.numero_paciente)
  c.id,
  c.psicologo_id,
  c.numero_paciente
from public.conversaciones as c
order by
  c.psicologo_id,
  c.numero_paciente,
  c.updated_at desc nulls last,
  c.created_at desc nulls last,
  c.id asc;

-- 1b. Exception-safe timestamp parse, scoped to this session only.
--     jsonb_typeof only proves a value is a string, never that it PARSES, so a
--     direct ::timestamptz cast raises on free text ("ayer a las 10"), on an
--     out-of-range field (2024-13-45), on a shape-valid but calendar-invalid
--     instant (2024-02-30), and on a negative UTC offset with no time-of-day
--     (2024-03-01-05:30). Because this whole script is one transaction, any one of
--     those aborts the run before step 4 creates the constraint the Edge Function
--     upsert depends on. A shape regex cannot close that class, since the guard
--     itself decides what Postgres would accept, so the cast is made
--     exception-safe instead and every unusable value becomes null, which the merge
--     treats as "no usable timestamp" and orders last while PRESERVING the entry.
--     pg_temp scopes the helper to this session, leaving no object behind.
create or replace function pg_temp.parse_historial_timestamp(value text)
returns timestamptz
language plpgsql
immutable
as $$
begin
  return value::timestamptz;
exception
  when others then
    return null;
end;
$$;

-- 2. Merge every group member's historial into the survivor.
--    - historial is concatenated, never discarded.
--    - Elements are ordered by their own message timestamp ascending. Elements
--      without a usable string timestamp keep their relative order and are placed
--      last, so nothing is lost and the resulting order stays deterministic.
--    - Ties are broken by the owning member's identity and then by the element's
--      position inside that member: member_created_at, member_id, element_ordinality.
--      That chain is total, so re-running this migration cannot reorder an already
--      merged historial. It must NOT be expressed as a window function inside the
--      LATERAL below: a window there is scoped to a single member's jsonb array and
--      restarts at 1 for every member, which would leave equal-timestamp elements
--      from different members ordered by element_ordinality alone, i.e. arbitrarily.
--    - The filter on element_ordinality drops only the NULL padding row that the
--      LEFT JOIN LATERAL emits for a member with an empty historial array, so an
--      empty array stays an empty array instead of becoming [null].
--    - A value that Postgres cannot parse is ordered last rather than aborting the
--      run, so historial content is never lost to a bad timestamp. The migration
--      deliberately does not assume a well-formed shape: the only live writers
--      stamp entries with new Date().toISOString() at webhook/index.ts:157 and
--      webhook/index.ts:162, but src/services/supabase.ts:69-92 also accepts an
--      arbitrary caller-supplied historial array with an unvalidated timestamp
--      string, and that path must not be able to abort a schema migration. The one
--      behavior that remains is inherent to any timestamp sort: a parseable but
--      semantically wrong instant orders by the instant it actually denotes.
--    - created_at becomes min(created_at) and updated_at becomes max(updated_at)
--      across the group, the widest possible window for the conversation lifetime.
--      A null merged value keeps the survivor's own value rather than nulling it.
--    - ultima_actividad is intentionally left untouched. It is a denormalized
--      "last write" marker owned by appendMessagesToConversacion, and this
--      migration introduces no new message data that would justify moving it.
update public.conversaciones as survivor
set
  historial = merged.historial,
  created_at = coalesce(merged.min_created_at, survivor.created_at),
  updated_at = coalesce(merged.max_updated_at, survivor.updated_at)
from (
  select
    survivors.id as survivor_id,
    coalesce(
      jsonb_agg(
        elements.element
        order by
          elements.element_timestamp asc nulls last,
          elements.member_created_at asc nulls last,
          elements.member_id asc,
          elements.element_ordinality asc
      ) filter (where elements.element_ordinality is not null),
      '[]'::jsonb
    ) as historial,
    min(members.created_at) as min_created_at,
    max(members.updated_at) as max_updated_at
  from conversation_dedup_survivors as survivors
  join public.conversaciones as members
    on members.psicologo_id = survivors.psicologo_id
   and members.numero_paciente = survivors.numero_paciente
  left join lateral (
    select
      entries.value as element,
      entries.ordinality as element_ordinality,
      members.created_at as member_created_at,
      members.id as member_id,
      case
        when jsonb_typeof(entries.value) = 'object'
          and entries.value ? 'timestamp'
          and jsonb_typeof(entries.value -> 'timestamp') = 'string'
        then pg_temp.parse_historial_timestamp(entries.value ->> 'timestamp')
        else null
      end as element_timestamp
    from jsonb_array_elements(
      case
        when jsonb_typeof(members.historial) = 'array' then members.historial
        else '[]'::jsonb
      end
    ) with ordinality as entries (value, ordinality)
  ) as elements on true
  group by survivors.id
) as merged
where survivor.id = merged.survivor_id;

-- 3. Drop the losing rows, now that their historial has been merged forward.
delete from public.conversaciones as loser
using conversation_dedup_survivors as survivors
where loser.psicologo_id = survivors.psicologo_id
  and loser.numero_paciente = survivors.numero_paciente
  and loser.id <> survivors.id;

-- 4. Add a real UNIQUE constraint, not a bare index, so ON CONFLICT upserts can
--    target it. Guarded on pg_constraint so re-running this migration is a no-op.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.conversaciones'::regclass
      and conname = 'conversaciones_psicologo_id_numero_paciente_key'
      and contype = 'u'
  ) then
    alter table public.conversaciones
      add constraint conversaciones_psicologo_id_numero_paciente_key
      unique (psicologo_id, numero_paciente);
  end if;
end
$$;

-- 5. Restore the updated_at trigger suspended in step 0.
do $$
begin
  if exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.conversaciones'::regclass
      and tgname = 'set_updated_at'
      and not tgisinternal
  ) then
    execute 'alter table public.conversaciones enable trigger set_updated_at';
  end if;
end
$$;

comment on constraint conversaciones_psicologo_id_numero_paciente_key
  on public.conversaciones is
  'One conversation row per (psicologo_id, numero_paciente). Required by the atomic getOrCreateConversacion upsert.';

commit;
