-- Migratie: automatisch publiceren (fase A: Facebook + Instagram)
-- Plakken in de Supabase SQL Editor en Run (bij waarschuwing: "Run without RLS").

-- 1. Publiceer-velden op posts
alter table mkt_posts add column if not exists media_url text not null default '';
alter table mkt_posts add column if not exists auto_publish boolean not null default false;
alter table mkt_posts add column if not exists publiceer_log text not null default '';

-- 2. Openbare media-bucket (voor foto's/video's; Meta haalt ze via publieke URL op)
insert into storage.buckets (id, name, public) values ('media', 'media', true)
on conflict (id) do nothing;
do $$ begin
  create policy "media team upload" on storage.objects
    for insert to authenticated with check (bucket_id = 'media');
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "media publiek lezen" on storage.objects
    for select using (bucket_id = 'media');
exception when duplicate_object then null; end $$;
do $$ begin
  create policy "media team beheren" on storage.objects
    for delete to authenticated using (bucket_id = 'media');
exception when duplicate_object then null; end $$;

-- 3. Publisher elke 10 minuten (publiceert posts met 🚀 zodra datum+tijd bereikt is)
do $x$ begin perform cron.unschedule('publisher'); exception when others then null; end $x$;
select cron.schedule('publisher', '*/10 * * * *', $job$
  select net.http_post(
    url:='https://gyhrwjdlwamyjhxtdypw.supabase.co/functions/v1/publisher',
    headers:=jsonb_build_object('Content-Type','application/json',
      'Authorization','Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c',
      'apikey','eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd5aHJ3amRsd2FteWpoeHRkeXB3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODgwMzUsImV4cCI6MjA5NzM2NDAzNX0.M2huzUfbYtcOqimYIkcuGW-6BCion4HqJVn7TxtkZ9c',
      'x-cron-key','bcfeed3a0efadda9bede03681e6ee2435b87a5194c3c3aed'),
    body:='{}'::jsonb)
$job$);

select jobname, schedule, active from cron.job order by jobname;
