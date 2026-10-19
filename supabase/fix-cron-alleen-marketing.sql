-- ═══ Geplande MARKETING-taken herstellen, zonder iets aan het CRM te veranderen (19 okt 2026) ═══
-- Neemt de sleutel over uit de CRM-taak lead-radar (die blijft zelf onaangeroerd) en zet die in
-- ALLEEN de marketingtaken: meta-sync-uurlijks, publisher, ad-guard-ochtend, ad-guard-middag.
-- Het secret CRON_SECRET wordt NIET veranderd. Er staat geen geheim in dit bestand en het script
-- toont de sleutel nergens. Plakken in Supabase → SQL Editor → Run.
do $$
declare
  sleutel text;
  anon text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c';
  j record; cmd text; n int := 0;
begin
  select substring(command from '''x-cron-key''\s*,\s*''([^'']*)''') into sleutel
    from cron.job where jobname like 'lead-radar%' and command like '%x-cron-key%' limit 1;
  if sleutel is null or length(sleutel) < 10 then
    raise exception 'Kon geen sleutel vinden in de lead-radar-taak — niets veranderd';
  end if;
  for j in select jobid, command from cron.job
           where jobname in ('meta-sync-uurlijks','publisher','ad-guard-ochtend','ad-guard-middag') loop
    cmd := regexp_replace(j.command, '(''x-cron-key''\s*,\s*'')[^'']*('')', '\1' || sleutel || '\2', 'g');
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
  raise notice '% marketingtaken bijgewerkt (CRM ongemoeid)', n;
end $$;

select jobname,
       command like '%x-cron-key%'   as heeft_sleutel,
       command like '%Authorization%' as heeft_login
  from cron.job order by jobname;
