-- ═══ MIGRATIE: taakgebied + duur op mkt_taken (19 okt 2026) ═══
-- Voor de weekbalans in Mijn week: elke taak hoort bij een taakgebied
-- (content / ads / werving / web / overig) en heeft een geschatte duur in minuten.
-- Bestaande taken krijgen 'overig' en 60 minuten. Idempotent.
-- Plakken in de Supabase SQL Editor en runnen.
alter table public.mkt_taken add column if not exists gebied text not null default 'overig';
alter table public.mkt_taken add column if not exists duur_min int not null default 60;
