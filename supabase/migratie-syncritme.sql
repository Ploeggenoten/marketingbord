-- ═══ MARKETINGBORD · syncritme herstellen (7 aug 2026) ═══
-- Werkbare versie mét sleutel staat buiten de repo (Claude schrijft die per sessie).
-- Plakken in Supabase → SQL Editor → Run.  NIET in de repo zetten: de sleutel hieronder is geheim.
--
-- STAP 1 — bewijs: draaien de afspraken nog?  (kijk naar status/return_message)
select jobid, jobname, schedule, active from cron.job order by jobname;
select j.jobname, d.status, left(coalesce(d.return_message,''), 80) as bericht, d.start_time
  from cron.job_run_details d join cron.job j using (jobid)
 order by d.start_time desc limit 20;

-- STAP 2 — opnieuw inplannen mét de huidige CRON_SECRET
do $x$ begin perform cron.unschedule('meta-sync-ochtend');  exception when others then null; end $x$;
do $x$ begin perform cron.unschedule('meta-sync-middag');   exception when others then null; end $x$;
do $x$ begin perform cron.unschedule('meta-sync-uurlijks'); exception when others then null; end $x$;
do $x$ begin perform cron.unschedule('meta-sync-halfuur');  exception when others then null; end $x$;
do $x$ begin perform cron.unschedule('ad-guard-ochtend');   exception when others then null; end $x$;
do $x$ begin perform cron.unschedule('ad-guard-middag');    exception when others then null; end $x$;

-- elk half uur, 07:00-20:30 NL (zomertijd = UTC+2)
select cron.schedule('meta-sync-halfuur', '*/30 5-18 * * *', $job$
  select net.http_post(
    url:='https://gyhrwjdlwamyjhxtdypw.supabase.co/functions/v1/meta-sync',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-key','<<CRON_SECRET — nooit in deze publieke repo; waarde staat in ~/.claude/ploeggenoten-secrets.env>>'),
    body:='{}'::jsonb)
$job$);

-- waakhond 2x per dag: 08:00 en 14:00 NL
select cron.schedule('ad-guard-ochtend', '0 6 * * *', $job$
  select net.http_post(
    url:='https://gyhrwjdlwamyjhxtdypw.supabase.co/functions/v1/ad-guard',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-key','<<CRON_SECRET — nooit in deze publieke repo; waarde staat in ~/.claude/ploeggenoten-secrets.env>>'),
    body:='{}'::jsonb)
$job$);
select cron.schedule('ad-guard-middag', '0 12 * * *', $job$
  select net.http_post(
    url:='https://gyhrwjdlwamyjhxtdypw.supabase.co/functions/v1/ad-guard',
    headers:=jsonb_build_object('Content-Type','application/json','x-cron-key','<<CRON_SECRET — nooit in deze publieke repo; waarde staat in ~/.claude/ploeggenoten-secrets.env>>'),
    body:='{}'::jsonb)
$job$);

-- STAP 3 — controle: 3 jobs, allemaal active = true
select jobname, schedule, active from cron.job order by jobname;
