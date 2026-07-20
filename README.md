# Ploeggenoten · Marketingbord

Content-pijplijn voor Bryan (marketeer): **Idee → Script klaar → Ingepland → Gepubliceerd → Learnings**, met kalenderweergave en resultaten per post.

Derde app naast het [pijplijnbord](https://ploeggenoten.github.io/pijplijnbord/) en de [finance-app](https://ploeggenoten.github.io/ploeggenoten-finance/). Zelfde stack: statische single-file app + Supabase (teamlogin, zelfde `profiles` als het bord) + GitHub Pages.

## Deploy
`git push origin main` → live via GitHub Pages.

## Database
Eenmalig `supabase/schema.sql` draaien in de Supabase SQL Editor (project `gyhrwjdlwamyjhxtdypw`). Idempotent — opnieuw draaien kan geen kwaad. Tabellen: `mkt_posts`, `mkt_kanalen` (RLS: heel het team, `authenticated`).

## Lokaal testen
`python3 -m http.server 8128` in deze map (launch-config **marketing**). Login is Supabase-auth; zelfde accounts als het pijplijnbord.

## Roadmap (afgestemd met Tjeerd, 20 jul 2026)
1. ✅ Marketing-bord (deze app)
2. Meta-koppeling — Marketing/Graph API via Supabase Edge Function (token server-side, Yuki-patroon): ad-uitgaven, kosten/lead, bereik; keten sluiten met bord (bron 'Meta') + finance (fees) → kosten per plaatsing per campagne
3. Advies-agent — Claude API in Edge Function: dagelijkse creative-adviezen, wekelijkse trend-research die ideeën in het bord legt, Meta Ad Library-monitor voor concurrenten
