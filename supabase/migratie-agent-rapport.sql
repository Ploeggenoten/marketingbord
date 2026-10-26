-- ═══ MIGRATIE: mkt_agent_rapport — advies van de Meta-campagne-agent (26 okt 2026) ═══
-- Eén rij per run van ad-guard v4: het volledige rapport (kort oordeel, oordeel per campagne,
-- waarschuwingen, strategisch punt, niet beoordeeld, vraag) + wat er automatisch is uitgevoerd.
-- Bryan kan in het bord de vraag beantwoorden (antwoord); de agent leest die bij de volgende run.
-- Idempotent. Plakken in de Supabase SQL Editor en runnen — VÓÓR het deployen van ad-guard v4.
create table if not exists public.mkt_agent_rapport (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  rapport     jsonb not null default '{}'::jsonb,
  uitgevoerd  jsonb not null default '[]'::jsonb,
  model       text not null default '',
  antwoord    text not null default '',
  antwoord_op timestamptz,
  antwoord_door text not null default ''
);
alter table public.mkt_agent_rapport enable row level security;
drop policy if exists "team lezen mkt_agent_rapport" on public.mkt_agent_rapport;
create policy "team lezen mkt_agent_rapport" on public.mkt_agent_rapport for select to authenticated using (true);
drop policy if exists "team antwoorden mkt_agent_rapport" on public.mkt_agent_rapport;
create policy "team antwoorden mkt_agent_rapport" on public.mkt_agent_rapport for update to authenticated using (true) with check (true);
