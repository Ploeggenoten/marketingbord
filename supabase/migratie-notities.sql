-- ═══ MIGRATIE: mkt_notities — notitieblok in Mijn week (20 okt 2026) ═══
-- Eerst noteren, later pas omzetten in taken. Team-RLS zoals mkt_taken.
-- Idempotent. Plakken in de Supabase SQL Editor en runnen.
create table if not exists public.mkt_notities (
  id uuid primary key default gen_random_uuid(),
  tekst text not null default '',
  door text default '',
  verwerkt boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mkt_notities enable row level security;

drop policy if exists "team alles mkt_notities" on public.mkt_notities;
create policy "team alles mkt_notities" on public.mkt_notities
  for all to authenticated using (true) with check (true);
