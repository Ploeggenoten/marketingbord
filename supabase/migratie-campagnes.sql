-- ═══ MIGRATIE: mkt_meta_campagnes — campagne-overzicht bovenaan Prestatie (26 okt 2026) ═══
-- Gevuld door de Edge Function meta-sync: per campagne status (aan/uit), budget, campagne-id
-- en kerncijfers voor vandaag / 7 dagen / 30 dagen (incl. frequentie en CPM uit Meta).
-- Idempotent. Plakken in de Supabase SQL Editor en runnen.
create table if not exists public.mkt_meta_campagnes (
  id              text primary key,          -- Meta campagne-id
  naam            text not null default '',
  status          text not null default '',  -- effective_status (ACTIVE, PAUSED, …)
  aan             boolean not null default false,
  budget_type     text not null default '',  -- 'campagne' (CBO) of 'sets' (ABO)
  budget_dag      numeric,
  budget_looptijd numeric,
  doel            text not null default '',
  cijfers         jsonb not null default '{}'::jsonb,   -- { vandaag:{…}, d7:{…}, d30:{…} }
  synced_at       timestamptz not null default now()
);
alter table public.mkt_meta_campagnes enable row level security;
drop policy if exists "team lezen mkt_meta_campagnes" on public.mkt_meta_campagnes;
create policy "team lezen mkt_meta_campagnes" on public.mkt_meta_campagnes
  for select to authenticated using (true);
