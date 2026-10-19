-- ═══ MARKETINGBORD · link-klikken voor het 2·1·5-kader (19 okt 2026) ═══
-- Het 2·1·5-kader (link-CTR > 2%, link-CPC < €1, CPL < €5) rekent met KLIKKEN OP
-- DE LINK. De kolom `kliks` bevat Meta's `clicks` (alle klikken: profiel, "meer
-- weergeven", reacties) en geeft een te rooskleurig beeld. meta-sync vult vanaf nu
-- ook `link_kliks` (Meta: inline_link_clicks). Oude rijen worden bij de volgende
-- sync vanzelf bijgewerkt (de sync haalt steeds de laatste 30 dagen opnieuw op).
-- Idempotent. Plakken in Supabase → SQL Editor → Run.
alter table mkt_meta_stats add column if not exists link_kliks int not null default 0;
