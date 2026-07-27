-- ═══ MIGRATIE: mkt_taken — Bryan's weekplanner (Mijn week-tab) ═══
-- Plakken in de Supabase SQL Editor en runnen. Team-RLS zoals mkt_posts.

create table if not exists public.mkt_taken (
  id uuid primary key default gen_random_uuid(),
  tekst text not null,
  datum date not null default current_date,
  klaar boolean not null default false,
  door text default '',
  created_at timestamptz not null default now()
);

alter table public.mkt_taken enable row level security;

drop policy if exists "team alles mkt_taken" on public.mkt_taken;
create policy "team alles mkt_taken" on public.mkt_taken
  for all to authenticated using (true) with check (true);

-- realtime zodat de planner live meebeweegt op alle schermen
do $$
begin
  alter publication supabase_realtime add table public.mkt_taken;
exception when duplicate_object then null;
end $$;
