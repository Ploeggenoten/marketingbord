-- ═══ Advies van de agent elke ochtend om 08:00 Nederlandse tijd (27 okt 2026) ═══
-- pg_cron rekent in UTC. 08:00 NL is 07:00 UTC in de winter en 06:00 UTC in de zomer.
-- Daarom draait de taak om 06:00 én 07:00 UTC, maar roept hij ad-guard alleen aan als het in
-- Amsterdam 08:00 is. Zo klopt het het hele jaar, ook na het verzetten van de klok.
-- Alleen de taak ad-guard-ochtend verandert; de sleutel erin blijft staan (staat niet in dit bestand).
-- Plakken in Supabase → SQL Editor → Run.
do $$
declare j record; cmd text;
begin
  select jobid, command into j from cron.job where jobname = 'ad-guard-ochtend';
  if j.jobid is null then raise exception 'Taak ad-guard-ochtend niet gevonden — niets veranderd'; end if;
  cmd := j.command;
  if cmd not like '%Europe/Amsterdam%' then
    cmd := regexp_replace(cmd, '[\s;]+$', '') ||
           E'\n  where extract(hour from now() at time zone ''Europe/Amsterdam'') = 8';
  end if;
  perform cron.alter_job(j.jobid, schedule := '0 6,7 * * *', command := cmd, active := true);
end $$;

select jobname, schedule, active,
       command like '%Europe/Amsterdam%' as om_8_uur_nl,
       command like '%x-cron-key%'       as heeft_sleutel
  from cron.job where jobname like 'ad-guard%' order by jobname;
