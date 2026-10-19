-- ═══ MIGRATIE: koppeling taken ↔ Teams/Outlook-agenda (19 okt 2026) ═══
-- Per taak het id van de bijbehorende agenda-afspraak en een vingerafdruk van wat er
-- het laatst is doorgestuurd (dan worden alleen echte wijzigingen opnieuw verstuurd).
-- Idempotent. Plakken in de Supabase SQL Editor en runnen.
alter table public.mkt_taken add column if not exists outlook_id   text not null default '';
alter table public.mkt_taken add column if not exists outlook_sync text not null default '';
