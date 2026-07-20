# Meta-koppeling activeren (fase 2) — eenmalige setup

De Edge Function `meta-sync` is al gedeployed en de app is er klaar voor. Er ontbreken alleen twee geheimen die **jij of Bryan** zelf moet aanmaken en plakken (Claude typt principieel geen tokens in). Duur: ± 15 minuten.

## Stap 1 — Advertentieaccount-ID opzoeken
1. Ga naar [business.facebook.com](https://business.facebook.com) → **Instellingen** (Business-instellingen).
2. **Accounts → Advertentieaccounts** → noteer het ID (een cijferreeks, bijv. `1234567890`).
   - Sneltruc: in Ads Manager staat het ook in de URL achter `act=`.

## Stap 2 — Meta-app aanmaken
1. Ga naar [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**.
2. Use case: **Other** → type **Business**. Naam: bijv. `Ploeggenoten Marketing`.
3. Koppel de app aan jullie Business Manager (Business-portfolio) als daarom gevraagd wordt.

## Stap 3 — System User + token (verloopt niet, veiligste route)
1. Business-instellingen → **Gebruikers → Systeemgebruikers** → **Toevoegen**.
   - Naam: `marketing-sync`, rol: **Medewerker** (Employee).
2. Klik bij de systeemgebruiker op **Assets toewijzen** → kies het **advertentieaccount** → zet **Prestaties bekijken** (view performance) aan.
3. Klik **Token genereren**:
   - Kies de app uit stap 2.
   - Vervaldatum: **Nooit** (of 60 dagen als je dat prettiger vindt — dan wel elke 2 mnd verversen).
   - Machtiging: alleen **`ads_read`** aanvinken. Meer is niet nodig.
4. Kopieer de token (je ziet hem maar één keer).

## Stap 4 — Secrets in Supabase plakken
1. Ga naar [Edge Functions → Secrets](https://supabase.com/dashboard/project/gyhrwjdlwamyjhxtdypw/functions/secrets).
2. Voeg toe:
   - `META_ACCESS_TOKEN` = de token uit stap 3
   - `META_AD_ACCOUNT_ID` = het cijfer-ID uit stap 1 (met of zonder `act_` maakt niet uit)

## Stap 5 — Testen
Open het [marketingbord](https://ploeggenoten.github.io/marketingbord/) → tab **📊 Prestatie** → knop **↻ Sync nu**. Binnen een paar seconden staan de laatste 30 dagen aan campagnecijfers (CPC, CTR, leads, €/lead) in de tabel. Daarna ververst het elke 6 uur vanzelf zodra iemand de app opent.

### Opmerkingen
- De token blijft **alleen server-side** in de Edge Function (zelfde patroon als de Yuki-sleutel); de app leest alleen de tabel `mkt_meta_stats`.
- App in "development mode" is prima — voor het lezen van je **eigen** advertentiedata met `ads_read` is geen App Review nodig.
- Registreer kandidaten uit Meta-campagnes op het pijplijnbord met bron **Meta** — dan rekent de Prestatie-tab automatisch kosten per kandidaat en per plaatsing uit.
