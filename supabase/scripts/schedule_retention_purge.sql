-- Schedules the daily retention purge from migration 008. NOT a migration.
--
-- Run it by hand, once, after confirming that deleting conversations without
-- activity for 90 days is intended: the first run deletes every conversation that is
-- already older than that, and it cannot be undone. Preview first:
--
--   select count(*) from public.conversaciones
--   where coalesce(ultima_actividad, updated_at, created_at) < now() - interval '90 days';
--
-- Requires the pg_cron extension (Dashboard > Integrations > Cron, or the statement
-- below). Re-running this script replaces the job instead of adding a second one.

create extension if not exists pg_cron with schema pg_catalog;

-- Every day at 07:00 UTC (03:00 or 04:00 in Chile, depending on daylight saving time).
select cron.schedule(
  'artemisa-retention-purge',
  '0 7 * * *',
  $$select * from public.purge_expired_personal_data(interval '90 days')$$
);

-- To stop it:
--   select cron.unschedule('artemisa-retention-purge');
-- To see past runs:
--   select status, return_message, start_time from cron.job_run_details
--   where jobid = (select jobid from cron.job where jobname = 'artemisa-retention-purge')
--   order by start_time desc limit 10;
