# Taken in de Teams/Outlook-agenda — eenmalige stap voor Tjeerd (±2 minuten)

Het marketingbord zet Bryans taken uit **Mijn week** als afspraken in zijn eigen
Outlook/Teams-agenda. Daarvoor gebruikt het dezelfde Microsoft-app als het CRM
(**Ploeggenoten CRM**, client-id `d07d8bf0-82b1-426e-89c6-3ae11393b982`). Die heeft al
`Calendars.ReadWrite` met beheerderstoestemming — er komen dus geen nieuwe rechten bij.
Alleen de adressen van het marketingbord moeten als toegestane terugkeer-adressen worden
toegevoegd, anders weigert Microsoft het inloggen (fout AADSTS50011).

## Stappen (Microsoft 365-beheerder)
1. Ga naar https://entra.microsoft.com → **Identiteit → App-registraties** → **Ploeggenoten CRM**.
2. **Verificatie** (Authentication) → bij **Single-page application** → **URI toevoegen**:
   - `https://ploeggenoten.github.io/marketingbord/`
   - `http://localhost:8128/`
3. **Opslaan**. Klaar.

## Daarna (Bryan)
- Draai eenmalig `supabase/migratie-taak-outlook.sql` in de Supabase SQL Editor.
- Klik in **Mijn week** op **🔗 Teams-agenda koppelen** en log in met je eigen
  Ploeggenoten-account.

## Wat er gebeurt
- Alleen in Bryans eigen agenda, alleen zijn eigen taken vanaf vandaag.
- Nieuwe/verschoven/aangepaste taken worden bijgewerkt; verwijderde taken verdwijnen uit de
  agenda; afgevinkte taken krijgen een ✓ in de titel. Afspraken staan op "bezet", zonder
  herinnering, met categorie "Marketingbord".
- Eén richting: wijzigingen die je in Outlook zelf doet, gaan niet terug naar het bord.
- Er staat geen geheim in de app; het token blijft in Bryans eigen browser.
