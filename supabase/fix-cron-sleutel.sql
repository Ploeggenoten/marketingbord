-- ═══ Geplande taken herstellen (19 okt 2026) ═══
-- Probleem: de planner (pg_cron) stuurt een x-cron-key mee die niet meer gelijk is aan het
-- secret CRON_SECRET van de Edge Functions → publisher, meta-sync en ad-guard antwoorden 403
-- ("geen toegang"); één taak mist bovendien een login-header (401 Invalid JWT).
-- Dit script zet in ÁLLE geplande taken die een Edge Function aanroepen (ook lead-radar uit het CRM):
--   1. de nieuwe sleutel als x-cron-key
--   2. een login-header met de publieke anon-sleutel (staat ook gewoon in index.html)
--   3. bij ad-guard een wachttijd van 150 s (de agent doet er ruim een minuut over)
-- Er staat GEEN geheim in dit bestand: je plakt je nieuwe sleutel zelf op regel 13.
-- Plakken in Supabase → SQL Editor → Run.
do $$
declare
  nieuw text := 'PLAK_HIER_JE_NIEUWE_SLEUTEL';
  anon  text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c';
  j record; cmd text; n int := 0;
begin
  if nieuw like 'PLAK%' or length(nieuw) < 20 then
    raise exception 'Plak eerst je nieuwe sleutel op regel 13';
  end if;
  for j in select jobid, command from cron.job where command like '%/functions/v1/%' loop
    cmd := j.command;
    cmd := regexp_replace(cmd, '(''x-cron-key''\s*,\s*'')[^'']*('')', '\1' || nieuw || '\2', 'g');
    if cmd not like '%Authorization%' then
      cmd := regexp_replace(cmd, 'jsonb_build_object\(',
        'jsonb_build_object(''Authorization'',''Bearer ' || anon || ''',''apikey'',''' || anon || ''',');
    end if;
    if cmd like '%/functions/v1/ad-guard%' and cmd not like '%timeout_milliseconds%' then
      cmd := regexp_replace(cmd, '::jsonb\s*\)', '::jsonb, timeout_milliseconds := 150000)');
    end if;
    perform cron.alter_job(j.jobid, command := cmd);
    n := n + 1;
  end loop;
  raise notice '% geplande taken bijgewerkt', n;
end $$;

-- Controle (laat geen sleutels zien): elke taak die een functie aanroept → beide kolommen true
select jobname,
       command like '%x-cron-key%'   as heeft_sleutel,
       command like '%Authorization%' as heeft_login
  from cron.job order by jobname;
