-- ═══ MIGRATIE: mkt_notities — "Notities van vandaag" in Mijn week (20 okt 2026) ═══
-- Eén notitievak per dag; eerst noteren, later omzetten in taken. Team-RLS zoals mkt_taken.
-- Idempotent (ook veilig als je de eerdere versie van dit bestand al hebt gedraaid).
-- Plakken in de Supabase SQL Editor en runnen.
create table if not exists public.mkt_notities (
  id uuid primary key default gen_random_uuid(),
  tekst text not null default '',
  door text default '',
  verwerkt boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.mkt_notities add column if not exists datum date;

alter table public.mkt_notities enable row level security;

drop policy if exists "team alles mkt_notities" on public.mkt_notities;
create policy "team alles mkt_notities" on public.mkt_notities
  for all to authenticated using (true) with check (true);
