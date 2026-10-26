-- ═══ MIGRATIE: videocijfers per advertentie per dag (26 okt 2026) ═══
-- Voor het blok "Video-prestaties" in Prestatie. Gevuld door meta-sync.
-- video_tijd_sec = totale kijktijd (gemiddelde × starts), zodat het gemiddelde over elke periode klopt.
-- Idempotent. Plakken in de Supabase SQL Editor en runnen — VÓÓR het deployen van de nieuwe meta-sync.
alter table public.mkt_meta_stats add column if not exists video_3s       int not null default 0;
alter table public.mkt_meta_stats add column if not exists video_p25      int not null default 0;
alter table public.mkt_meta_stats add column if not exists video_p50      int not null default 0;
alter table public.mkt_meta_stats add column if not exists video_p75      int not null default 0;
alter table public.mkt_meta_stats add column if not exists video_p95      int not null default 0;
alter table public.mkt_meta_stats add column if not exists thruplays      int not null default 0;
alter table public.mkt_meta_stats add column if not exists video_plays    int not null default 0;
alter table public.mkt_meta_stats add column if not exists video_tijd_sec numeric not null default 0;
