-- Migratie 21 jul 2026: advertentieset-niveau + dagelijkse agent-cron
-- Plakken in de Supabase SQL Editor en Run (bij RLS-waarschuwing: "Run without RLS").

-- 1. Advertentieset-kolom + nieuwe unieke sleutel voor de sync
alter table mkt_meta_stats add column if not exists advertentieset text not null default '';
alter table mkt_meta_stats drop constraint if exists mkt_meta_stats_datum_campagne_advertentie_key;
do $$ begin
  alter table mkt_meta_stats add constraint mkt_meta_stats_uniq unique (datum, campagne, advertentieset, advertentie);
exception when duplicate_table then null; when duplicate_object then null; end $$;

-- 2. Dagelijkse agent-runs (na de sync van 05:30/11:30 UTC)
do $x$ begin perform cron.unschedule('ad-guard-ochtend'); exception when others then null; end $x$;
do $x$ begin perform cron.unschedule('ad-guard-middag');  exception when others then null; end $x$;

select cron.schedule('ad-guard-ochtend', '0 6 * * *', $job$
  select net.http_post(
    url:='https://gyhrwjdlwamyjhxtdypw.supabase.co/functions/v1/ad-guard',
    headers:=jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c',
      'x-cron-key','bcfeed3a0efadda9bede03681e6ee2435b87a5194c3c3aed'),
    body:='{}'::jsonb)
$job$);

select cron.schedule('ad-guard-middag', '0 12 * * *', $job$
  select net.http_post(
    url:='https://gyhrwjdlwamyjhxtdypw.supabase.co/functions/v1/ad-guard',
    headers:=jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c',
      'x-cron-key','bcfeed3a0efadda9bede03681e6ee2435b87a5194c3c3aed'),
    body:='{}'::jsonb)
$job$);

select jobname, schedule, active from cron.job where jobname like 'ad-guard%' or jobname like 'meta-sync%';
