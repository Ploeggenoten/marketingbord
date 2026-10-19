-- ═══ MIGRATIE: vaste tijd per taak (19 okt 2026) ═══
-- Een taak kan een vast tijdstip krijgen ("14:00"); leeg = het bord plant hem zelf in.
-- Idempotent. Plakken in de Supabase SQL Editor en runnen.
alter table public.mkt_taken add column if not exists tijd text not null default '';
