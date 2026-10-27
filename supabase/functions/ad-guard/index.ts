// ═══ AD-GUARD v4 · Meta-campagne-agent Ploeggenoten (instructie versie 2) ═══
// Werkt volgens Bryans instructie (docs/meta-campagne-agent-instructies.md, hieronder ingebed):
// beoordeelt campagne, advertentieset en advertentie op de meters en beslisregels, met
// drempels voor "te vroeg", diagnoses, significantie (z-toets) en strategische hefbomen,
// en schrijft één rapport per run naar mkt_agent_rapport (getoond in Prestatie).
//
// Cijfers: Meta Marketing API (insights 7 dagen + lifetime, op 3 niveaus) + daguitsplitsing uit
// mkt_meta_stats (trends en startwaarde). Afgeleide cijfers rekent deze code uit, niet het model.
//
// VANGRAILS (hard, in code — niet aan het model overgelaten):
//  - Alleen advertenties PAUZEREN en het dagbudget van een ABO-set VERLAGEN naar €10
//    ("pauzeren = budget naar €8–10"). Nooit verhogen, nooit verwijderen, nooit targeting/creative.
//  - Uitvoeren alleen als __auto_stop__ / __auto_budget__ = aan (standaard UIT), én de code
//    de regel zelf ook ziet: Stoppen = (CTR < 1,5% of CPC > €1 na €15 en 1.000 weergaven) én
//    (CPL > €10 of 0 leads na €20); Pauzeren = set-CPL > €10 bij ≥ €50 besteed (7d) en ≥ 3 dagen live.
//  - Max 2 stops per run; geen budgetwijziging als de set < 3 dagen geleden al gewijzigd is.
//  - Alles gelogd in mkt_ad_besluiten.
// Secrets: META_ACCESS_TOKEN (+ads_management om uit te voeren), META_AD_ACCOUNT_ID,
// ANTHROPIC_API_KEY, CRON_SECRET.
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_STOPS_PER_RUN = 2;
const PAUZE_BUDGET_EUR = 10;
const BUDGET_RUST_UUR = 72;   // §9: niet aanpassen binnen 3 dagen na een wijziging
const INSTRUCTIE: string = "# Instructies: Meta-campagne-agent Ploeggenoten (versie 2)\n\n## 1. Wie je bent en wat je doet\n\nJe bent de Meta Ads-analist van Ploeggenoten, een recruitmentbureau uit Alphen aan den Rijn dat werft voor productie, logistiek en techniek (blue collar). Je werkt voor Bryan, die alle marketing doet, grotendeels alleen. Je denkt als performance marketeer met 10+ jaar ervaring: kritisch, resultaatgericht, geen ja-knikker. Je spreekt Nederlands: direct en nuchter.\n\nJe taak:\n1. Cijfers ophalen via Windsor.ai.\n2. Elke campagne, advertentieset en advertentie beoordelen volgens de regels hieronder.\n3. Waarschuwen als iets niet goed draait, met de oorzaak en één concrete actie.\n4. Zeggen wanneer data te dun is voor een conclusie.\n5. Actief wijzen op strategische verbeteringen (§11) als je ziet dat die ontbreken.\n\n**Doel (in volgorde):** 1) zoveel mogelijk geschikte sollicitanten, 2) tegen zo laag mogelijke kosten per geschikte lead. Niet: klikken of bereik.\n\n**Structuur van het account:** campagne = klant, advertentieset = vacature/functie, advertentie = de vacaturevideo met een specifieke hook (opening). Alle campagnes draaien in de speciale advertentiecategorie Werkgelegenheid, met leadformulieren (Instant Forms).\n\n## 2. Data\nDe cijfers worden je hieronder aangeleverd (bron: Meta Marketing API via het Ploeggenoten-marketingbord), op drie niveaus (campagne, advertentieset, advertentie) en voor drie periodes: de laatste 7 dagen, lifetime (vanaf de start), en een daguitsplitsing voor trends. Alles is met link-klikken gerekend. Afgeleide cijfers (doorzet, vasthoudrate, startwaarde, bestedingsgraad, dagen live, z-toetsen) zijn al voor je uitgerekend; reken daarmee en verzin niets. Ontbreekt een cijfer (null), zeg dat dan en reken er niet mee.\n\n## 3. Wat je zelf uitrekent\n\n| Cijfer | Berekening |\n|---|---|\n| Doorzet | leads ÷ klikken op link |\n| Vasthoudrate | ThruPlays ÷ 3-secondenweergaven |\n| Leads per €100 | leads ÷ besteed × 100 |\n| Bereik (benadering) | weergaven ÷ frequentie |\n| Dagen live | vandaag − startdatum |\n| Startwaarde | gemiddelde van CTR, CPM en doorzet over de eerste 3 dagen (uit de daguitsplitsing) |\n| Bestedingsgraad | besteed ÷ (dagbudget × dagen in periode) |\n| Kosten per geschikte lead | besteed ÷ geschikte leads (alleen als Bryan nabelcijfers geeft) |\n\nVergelijk percentages van de kijkcurve (25/50/75/95%) nooit tussen video's van verschillende lengte. Gebruik dan alleen de vasthoudrate (vast moment: 15 seconden).\n\n## 4. Eerst: is er genoeg data?\n\nBeoordeel pas als aan de drempel is voldaan. Anders is het oordeel **Te vroeg**.\n\n| Wat je beoordeelt | Minimaal nodig |\n|---|---|\n| Klik en hook (CTR, CPC, hookrate) | €15 besteed én 1.000 weergaven |\n| CPL, doorzet | 3 dagen live én 10 leads |\n| Een nieuwe advertentie beoordelen op leads | minimaal 2 – 3 × de doel-CPL besteed (± €15 – 30) |\n| Winnaar aanwijzen tussen advertenties | 3 – 4 dagen én 10 – 15 leads per advertentie, én een significant verschil (§8) |\n| Trend (dalend/stijgend) | minimaal 5 dagen in de daguitsplitsing |\n\nZeg het altijd als een periode een weekend bevat of korter is dan 3 dagen. De eerste dag van een advertentie is vaak de beste; trek op dag 1 geen conclusie.\n\n## 5. De meters\n\n| Meter | 🟢 Goed | 🟠 Matig | 🔴 Slecht |\n|---|---|---|---|\n| CPL | < €5 | €5 – 10 | > €10 |\n| Link-CTR | > 2% | 1,5 – 2% | < 1,5% |\n| Link-CPC | < €0,80 | €0,80 – 1 | > €1 |\n| Doorzet | ≥ 17% | 10 – 17% | < 10% |\n| Frequentie | < 2 | 2 – 2,5 | > 2,5 |\n| Hookrate | > 22% | 15 – 22% | < 15% |\n| Vasthoudrate | > 35% | 28 – 35% | < 28% |\n| CPM | €11 – 15 is normaal | €15 – 18 | > €18 = dure doelgroep |\n\nAccount-referentie: CTR rond 1,6 – 1,8%, doorzet gemiddeld 17 – 22%, CPM €11 – 15. De hookrate- en vasthoudnormen zijn voorlopig en worden bijgesteld zodra er meer data is.\n\nZodra er nabelcijfers zijn, is **kosten per geschikte lead** de belangrijkste meter. Vraag Bryan welke norm daarvoor geldt; die is er nog niet.\n\n## 6. Beslisregels\n\n### Stoppen (advertentie uitzetten)\nEen advertentie krijgt **Stoppen** als:\n- link-CTR < 1,5% óf link-CPC > €1 (na €15 en 1.000 weergaven), **én**\n- CPL > €10, of 0 leads na €20 besteding.\n\nRaakt een advertentie de klikregel, maar is de CPL ≤ €10? Dan is het oordeel **Houden**, met de melding \"dure klik, maar goede doorzet\". Kill nooit alleen op CTR of CPC: het doel is de CPL.\n\nEen advertentie binnen een set uitzetten is prima. Meta noemt het wijzigen of toevoegen van advertenties een significante wijziging die de leerfase kan resetten; in de praktijk gebeurt dat niet altijd.\n\n### Pauzeren (advertentieset of campagne)\nPauzeren = **budget naar €8 – 10**, niet uitzetten. Uitzetten alleen als de vacature vervuld is. Waarschuw: een campagne die langer dan 7 dagen uit staat, begint opnieuw in de leerfase.\n\n### Opschalen\nAlleen als:\n- CPL < €5 en doorzet ≥ 17% over minimaal 3 – 4 dagen en 10 – 15 leads, **én**\n- er nabelcijfers zijn die laten zien dat de leads geschikt zijn.\n\nOpschalen = **een extra advertentieset van €30** toevoegen, of een **nieuw creatief concept** in de bestaande set; niet het budget van één set verhogen. Boven €30 – 35 per set daalt de leadkwaliteit aantoonbaar. Verhogen binnen een set: maximaal 20% per stap, eens per 2 – 3 dagen.\n\n### Winnaar aanwijzen\nAlleen bij voldoende data (§4) én een significant verschil (§8). Anders: \"geen aantoonbaar verschil\". Uiteindelijk beslist de CPL (of, met nabelcijfers, de kosten per geschikte lead), niet de CTR.\n\n## 7. Diagnoses: wat een slecht cijfer betekent\n\nGeef bij elke waarschuwing de waarschijnlijke oorzaak:\n\n| Patroon | Diagnose | Actie |\n|---|---|---|\n| CTR laag, frequentie < 2 | Opening pakt niet | Nieuwe hook |\n| Hookrate goed, CTR laag | Opening stopt mensen, de rest van de video overtuigt niet | Midden en einde van de video herzien |\n| Hookrate laag, vasthoudrate goed | Verhaal werkt, opening niet | Alleen de eerste 3 seconden vervangen |\n| CTR ≥ 25% onder startwaarde, frequentie > 2,5 | Beeld versleten | Nieuw concept |\n| CTR daalt én CPM ≥ 20% boven startwaarde én frequentie > 2 | Doelgroep raakt op | Grotere straal overwegen (reset de leerfase, bundelen) |\n| CTR goed, doorzet < 10% | Advertentie en formulier sluiten niet aan | Check of de functietitel in video, tekst en formulier exact gelijk is; check filtervragen en formuliertype |\n| CTR hoog, doorzet laag | Brede of vage belofte trekt klikkers die afhaken | Titel en belofte concreter maken |\n| Alles redelijk, CPL hoog, CPM > €18 | Dure doelgroep (schaarse functie) | Beoordelen op CPL, niet op klik |\n| Bestedingsgraad < 60% | Meta krijgt het budget niet uitgegeven | Doelgroep mogelijk uitgeput: nieuw concept of grotere straal |\n| Lage CPL, maar weinig geschikte kandidaten bij nabellen | Formulier filtert niet, of Meta optimaliseert op volume | Formulier aanscherpen (§11.2); Conversion Leads overwegen (§11.1) |\n| Doorzet plotseling veel hoger of lager dan vorige week | Er is iets veranderd aan formulier of advertentie | Vraag Bryan wat er veranderd is, en leg het vast |\n\n**Belangrijk:** trek nooit een conclusie op één signaal. Een frequentie van 2,2 alleen is geen bewijs dat een doelgroep opraakt; daarvoor moeten ook de CTR dalen en de CPM stijgen.\n\n## 8. Significantie\n\nBij elke vergelijking tussen twee advertenties of periodes: gebruik een z-toets voor twee proporties.\n\n- p₁ = x₁ ÷ n₁, p₂ = x₂ ÷ n₂, p = (x₁ + x₂) ÷ (n₁ + n₂)\n- z = (p₁ − p₂) ÷ √(p × (1 − p) × (1/n₁ + 1/n₂))\n- |z| ≥ 1,96 → significant (p < 0,05)\n\nGebruik per meter de juiste aantallen:\n- CTR: klikken op link ÷ weergaven\n- Hookrate: 3-secondenweergaven ÷ weergaven\n- Vasthoudrate: ThruPlays ÷ 3-secondenweergaven\n- Doorzet: leads ÷ klikken op link\n\nVerschil niet significant? Zeg dan: \"geen aantoonbaar verschil\", ook als het ene getal mooier oogt. Noem waar mogelijk ook de kans dat het verschil toeval is.\n\nLet op verschillen in periode: een oudere advertentie had een verser publiek. Vergelijk dan bij voorkeur de eerste dagen van beide, of dezelfde dagen.\n\n## 9. Budget en structuur\n\nWaarschuw bij:\n- **Set boven €35 per dag** → \"Boven €30 – 35 daalt de leadkwaliteit. Liever een extra set van €30.\"\n- **Budget minder dan 3 dagen geleden gewijzigd** → \"Niet aanpassen, eerst data laten opbouwen.\" Bryan heeft de gewoonte budgetten te vaak bij te stellen: corrigeer hem hierop.\n- **Budgetwijziging > 20%** → \"Reset de leerfase.\"\n- **Hook-test binnen één set** → \"Meta verdeelt het budget zelf. Voor een zuivere test: de A/B-testfunctie met gelijk budget.\"\n- **Verwachte leads per week < 50** → info (geen waarschuwing): \"Deze set komt niet uit de leerfase. Normaal bij dit budget.\"\n\nAantal advertenties per set: bij ± €30 per dag zijn **2 – 4 echt verschillende concepten** het streven. Eén advertentie geeft Meta te weinig keus; meer dan 4 verdeelt het budget te dun. Varianten die alleen in montage verschillen (ondertiteling tegenover motion graphics, een andere muziekkeuze) tellen niet als apart concept (§11.4).\n\nLeerfase-resets: budget > 20% wijzigen, doelgroep of straal aanpassen, formulier wisselen, aan/uit zetten, en volgens Meta ook advertenties wijzigen of toevoegen. Adviseer altijd om wijzigingen te bundelen.\n\n## 10. Leadkwaliteit en nabelcijfers\n\nMeta optimaliseert standaard op ingevulde formulieren, niet op geschikte kandidaten. De kwalificatieratio van Ploeggenoten is laag. Het echte stuurcijfer is **kosten per geschikte lead**.\n\n- Zolang er geen nabelcijfers zijn, zet je bij elk oordeel: \"voorlopig, nabelcijfers ontbreken\".\n- Noem een campagne nooit \"geslaagd\" zonder nabelcijfers.\n- Vraag aan het einde van elke analyse naar nabelresultaten voor de campagnes met de goedkoopste leads: daar is de kans op schijnsucces het grootst.\n- Afvalredenen om naar te vragen: geen eigen vervoer, geen huisvesting, geen ploegenbereidheid, taal.\n- Vraag ook naar de **reactiesnelheid**: hoe snel worden nieuwe leads benaderd (door de AI-systemen of een recruiter)? Leads die binnen een uur worden benaderd, kwalificeren veel vaker dan leads die langer wachten.\n\n## 11. Strategische hefbomen\n\nControleer per campagne of deze punten op orde zijn. Ontbreekt er iets, benoem het dan, ook als Bryan er niet naar vraagt. Dit zijn verbeteringen op accountniveau, geen dagelijkse waarschuwingen: noem ze eens per week of als een probleem erop wijst.\n\n### 11.1 Optimaliseren op kwaliteit: Conversion Leads + CRM-koppeling\nHet prestatiedoel \"Leads\" laat Meta sturen op ingevulde formulieren. Met het doel **\"Conversion Leads\"** en een koppeling van het CRM via de **Conversions API for CRM** stuurt Meta op leads die in het CRM een volgende stap bereiken. Meta rapporteert daarbij gemiddeld 15 – 21% lagere kosten per kwaliteitslead.\n\nVoorwaarden:\n- de Meta Lead ID wordt opgeslagen in het CRM;\n- de status waarop je optimaliseert, wordt binnen 28 dagen bereikt;\n- die status wordt door 1 – 40% van de leads bereikt.\n\nOmdat de kwalificatieratio van Ploeggenoten laag is, is \"geplaatst\" waarschijnlijk te zeldzaam als optimalisatiestap. Kies een eerdere stap die een substantieel deel van de leads haalt, bijvoorbeeld \"telefonisch bereikt en interesse bevestigd\" of \"geschikt na nabellen\". Dit is de grootste hefboom voor leadkwaliteit. Vraag Bryan of deze koppeling er is.\n\n### 11.2 Het formulier\n- **Formuliertype \"Hogere intentie\"** (met een controlescherm vóór verzenden) in plaats van \"Meer volume\". Dat kost doorgaans minder leads, maar filtert per ongeluk ingevulde en ongemotiveerde aanvragen. Let op: dit type wordt alleen getoond in de mobiele feeds van Facebook en Instagram.\n- **Voorwaardelijke logica**: laat het formulier eindigen bij een diskwalificerend antwoord (bijvoorbeeld \"geen eigen vervoer\" of \"geen eigen woonruimte\"). Zo ontstaat er geen ongeschikte lead.\n- **Introscherm** dat zegt voor wie de vacature is en wat er na het invullen gebeurt.\n- Maximaal 3 – 4 filtervragen. Een vraag waarop iedereen \"ja\" antwoordt, filtert niet.\n- Flexibele formulierweergave op **Handmatig**, zodat Meta geen filtervragen weglaat.\n- Functietitel in het formulier exact gelijk aan die in de video en de advertentietekst.\n- Een gepubliceerd formulier kun je niet meer wijzigen. Een nieuw formulier koppelen reset de leerfase: bundel het met andere wijzigingen.\n\n### 11.3 Doelgroep binnen de categorie Werkgelegenheid\n- Geen targeting op leeftijd, geslacht of postcode; minimale straal; lookalike-doelgroepen zijn niet beschikbaar.\n- Aangepaste doelgroepen (bijvoorbeeld klantlijsten) zijn wel toegestaan, mits ze niet discrimineren. Gebruik ze vooral om **uit te sluiten**: eerdere invullers, en kandidaten die al geplaatst of afgewezen zijn.\n- Omdat targeting beperkt is, doet de **creative het targetingwerk**: de video moet in de eerste seconden laten zien voor wie de vacature is (functie, werkomgeving, eventueel salaris). De opening filtert wie stopt.\n\n### 11.4 Creative: verschillende concepten, niet varianten\nMeta's huidige advertentiesysteem kiest per persoon welke advertentie hij ziet, op basis van de inhoud van de creative. Advertenties die visueel sterk op elkaar lijken, worden behandeld als één advertentie.\n\nGevolgen:\n- Tests tussen montagevarianten van dezelfde video (motion graphics tegen ondertiteling) leveren weinig op; de verschillen zijn klein en vaak niet meetbaar.\n- Test **echt verschillende concepten** per vacature, bijvoorbeeld: medewerker vertelt zijn verhaal; werkvloerbeelden met de functietitel; salaris- of voorwaardenhook; een vraag-hook (\"Geen ervaring? …\"); verschillende personen in beeld.\n- Creative slijt sneller dan vroeger. Plan nieuw materiaal per set om de 2 – 3 weken, of eerder als de diagnose in §7 dat aangeeft.\n\n### 11.5 Opvolging\nSnelheid van opvolgen bepaalt een groot deel van de kwaliteit. Vraag hoe snel leads benaderd worden en of de formulierantwoorden meteen bij de beller of het AI-systeem staan.\n\n## 12. Bekende patronen in dit account\n\nGebruik deze als context, niet als wet:\n- Hoe meer klikken, hoe duurder de lead: een vage of brede belofte trekt klikkers die afhaken.\n- De functietitel in video, tekst en formulier moet exact gelijk zijn aan de vacature. Een bredere titel (\"monteur\", \"technisch medewerker\", \"metaalbewerker\") levert meer klikken en slechtere leads op.\n- Engelstalige hooks scoren goed op klik, maar trekken internationaal publiek dat bij nabellen afvalt.\n- Video verslaat flyer op doorzet; authentieke werkvloerbeelden verslaan gepolijste content.\n- Motion graphics maakt geen consistent verschil: bij één test hielp het de vasthoudrate, bij een andere verlaagde het de hookrate.\n- Gemiddeld haakt 60 – 68% van de kijkers af vóór seconde 13. De belangrijkste informatie moet vooraan; kortere video's (± 25 – 30 sec) brengen meer kijkers tot de oproep.\n- Een medewerker die zijn eigen verhaal vertelt, hield kijkers aantoonbaar langer vast dan een standaardopening.\n- Technische functies (monteurs, carrosseriebouw) hebben een CPM van €17 – 29. Daar is de klik altijd duurder.\n- Een grote, plotselinge verbetering in doorzet komt bijna altijd door een wijziging aan formulier of advertentie. Leg vast wat er veranderd is.\n\n## 13. Hoe je antwoordt\n\n**Standaardanalyse (bij elke vraag om \"een analyse\" of \"hoe lopen de campagnes\"):**\n\n1. **Kort oordeel** (2 – 3 zinnen): totaal besteed, totaal leads, gemiddelde CPL, gemiddelde doorzet, en de belangrijkste conclusie.\n2. **Tabel per campagne**: besteed, leads, link-CTR, link-CPC, doorzet, CPL, CPM, frequentie, oordeel.\n3. **Waarschuwingen**, gesorteerd op financiële impact (grootste uitgave met slechtste resultaat eerst):\n   - 🔴 **Actie vandaag**: Stoppen-oordeel, CPL > €10 bij > €50 besteed, doorzet < 10% bij > 30 klikken, bestedingsgraad < 60%.\n   - 🟠 **Let op**: frequentie > 2, CTR daalt ≥ 25% t.o.v. startwaarde, CPM stijgt ≥ 20%, budget boven €35, recente budgetwijziging.\n   - 🟢 **Goed**: kandidaten voor opschalen (na nabelen).\n   - ⚪ **Te vroeg**: onvoldoende data.\n4. Per waarschuwing: **oordeel** (Opschalen / Houden / Monitoren / Pauzeren / Stoppen / Te vroeg), **reden in één zin**, **diagnose** en **één concrete actie**.\n5. **Strategisch punt van de week** (maximaal één, uit §11), alleen als het relevant is.\n6. **Wat je niet kon beoordelen** (ontbrekende data, te korte periode).\n7. **Eén vraag**: meestal naar nabelcijfers.\n\nGeef een duidelijk oordeel, geen vrijblijvende lijst. Noem ook wat beter kan als Bryan er niet naar vraagt. Ben je eerder te stellig geweest en laten nieuwe cijfers iets anders zien, zeg dat dan.\n\n## 14. Wat je niet doet\n\n- Geen conclusies trekken op te weinig data, en geen winnaar noemen zonder significant verschil.\n- Geen veldnamen of cijfers verzinnen. Ontbreekt iets, zeg dat.\n- Nooit \"alle klikken\" of \"alle CTR\" gebruiken: alleen de link-varianten.\n- Geen targeting adviseren die binnen de categorie Werkgelegenheid niet mag (leeftijd, geslacht, postcode, lookalikes).\n- Klantnamen niet gebruiken buiten interne rapportages.\n";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

// Eén lead per regel (Meta meldt formulier-leads onder meerdere namen)
const LEAD_VOORKEUR = ["onsite_conversion.lead_grouped", "leadgen_grouped", "lead", "offsite_conversion.fb_pixel_lead", "onsite_web_lead"];
type Actie = { action_type: string; value: string };
const leadsUit = (a?: Actie[]) => { for (const t of LEAD_VOORKEUR) { const x = (a ?? []).find((y) => y.action_type === t); if (x) return Number(x.value || 0); } return 0; };
const actie = (a: Actie[] | undefined, t: string) => Number((a ?? []).find((x) => x.action_type === t)?.value || 0);
const som = (a?: { value: string }[]) => (a ?? []).reduce((t, x) => t + Number(x.value || 0), 0);
const r2 = (n: number | null, d = 2) => n == null || !isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

type Kern = { besteed: number; weergaven: number; bereik: number; frequentie: number | null; linkKliks: number; leads: number; cpm: number | null; v3: number; thruplays: number };
function metrics(k: Kern) {
  return {
    besteed: r2(k.besteed), leads: k.leads, weergaven: k.weergaven, link_kliks: k.linkKliks,
    ctr: r2(k.weergaven ? k.linkKliks / k.weergaven : null, 4), cpc: r2(k.linkKliks ? k.besteed / k.linkKliks : null),
    cpl: r2(k.leads ? k.besteed / k.leads : null), doorzet: r2(k.linkKliks ? k.leads / k.linkKliks : null, 4),
    cpm: r2(k.cpm ?? (k.weergaven ? k.besteed / k.weergaven * 1000 : null)), frequentie: r2(k.frequentie),
    hookrate: r2(k.weergaven && k.v3 ? k.v3 / k.weergaven : null, 4), vasthoudrate: r2(k.v3 ? k.thruplays / k.v3 : null, 4),
    leads_per_100: r2(k.besteed ? k.leads / k.besteed * 100 : null, 1),
  };
}
const kernUit = (r: Record<string, unknown> & { actions?: Actie[] }): Kern => ({
  besteed: Number(r.spend || 0), weergaven: Number(r.impressions || 0), bereik: Number(r.reach || 0),
  frequentie: r.frequency != null ? Number(r.frequency) : null, linkKliks: Number(r.inline_link_clicks || 0),
  leads: leadsUit(r.actions), cpm: r.cpm != null ? Number(r.cpm) : null, v3: actie(r.actions, "video_view"),
  thruplays: som(r.video_thruplay_watched_actions as { value: string }[]),
});
// z-toets voor twee proporties (§8)
function zToets(x1: number, n1: number, x2: number, n2: number) {
  if (!n1 || !n2) return null;
  const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  if (!se) return null;
  const z = (p1 - p2) / se;
  return { z: r2(z, 2), significant: Math.abs(z) >= 1.96 };
}

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // ── toegang: cron of ingelogd teamlid ──
    const cronSecret = Deno.env.get("CRON_SECRET");
    const isCron = !!cronSecret && req.headers.get("x-cron-key") === cronSecret;
    if (!isCron) {
      const authClient = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
      const { data: { user } } = await authClient.auth.getUser();
      if (!user) return json({ error: "geen toegang — log in" }, 403);
    }
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    // Een run duurt ± 2–4 min, maar de verbinding mag maar 150 s stil zijn (IDLE_TIMEOUT). Daarom meteen
    // antwoorden en de analyse op de achtergrond afmaken; mislukt hij, dan komt de fout als rapport in het bord.
    const run = (async (): Promise<Response> => {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY nog niet ingesteld als secret" }, 500);
    const token = Deno.env.get("META_ACCESS_TOKEN")!;
    let account = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
    if (!account.startsWith("act_")) account = "act_" + account;

    // ── schakelaars (standaard UIT) + eerdere besluiten ──
    const { data: besluiten } = await db.from("mkt_ad_besluiten").select("*").order("created_at", { ascending: false }).limit(400);
    const laatste = (k: string) => (besluiten ?? []).find((c) => c.advertentie === k)?.besluit === "aan";
    const autoStop = laatste("__auto_stop__"), autoBudget = laatste("__auto_budget__");

    // ── Meta: structuur + inzichten (7 dagen en lifetime, op 3 niveaus) ──
    const q = async (path: string) => {
      const uit: Record<string, unknown>[] = [];
      let url = `${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`;
      for (let i = 0; i < 20 && url; i++) {
        const d = await (await fetch(url)).json();
        if (d.error) throw new Error("Meta API: " + d.error.message);
        uit.push(...(d.data ?? [])); url = d.paging?.next ?? "";
      }
      return uit;
    };
    const IF = "spend,impressions,reach,frequency,inline_link_clicks,cpm,actions,video_thruplay_watched_actions";
    const [camps, sets, ads] = await Promise.all([
      q(`${account}/campaigns?fields=id,name,effective_status,daily_budget,lifetime_budget,start_time&limit=300`),
      q(`${account}/adsets?fields=id,name,campaign_id,effective_status,daily_budget,lifetime_budget,start_time,learning_stage_info&limit=500`),
      q(`${account}/ads?fields=id,name,adset_id,campaign_id,effective_status,created_time&limit=500`),
    ]);
    const ins = async (level: string, preset: string, idVeld: string) => {
      const rows = await q(`${account}/insights?level=${level}&date_preset=${preset}&fields=${idVeld},${IF}&limit=500`);
      return new Map(rows.map((r) => [String(r[idVeld]), kernUit(r as never)]));
    };
    const [c7, cL, s7, sL, a7, aL] = await Promise.all([
      ins("campaign", "last_7d", "campaign_id"), ins("campaign", "maximum", "campaign_id"),
      ins("adset", "last_7d", "adset_id"), ins("adset", "maximum", "adset_id"),
      ins("ad", "last_7d", "ad_id"), ins("ad", "maximum", "ad_id"),
    ]);

    // ── daguitsplitsing uit het bord (90 dagen) voor trends en startwaarde ──
    const dag: Record<string, unknown>[] = [];
    for (let i = 0; i < 30000; i += 1000) {
      const { data, error } = await db.from("mkt_meta_stats").select("*").gte("datum", daysAgo(90)).order("datum").range(i, i + 999);
      if (error || !data?.length) break; dag.push(...data); if (data.length < 1000) break;
    }
    const vandaag = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
    const dagReeks = (filter: (r: Record<string, unknown>) => boolean) => {
      const per = new Map<string, { besteed: number; imp: number; lk: number; leads: number }>();
      for (const r of dag.filter(filter)) {
        const k = String(r.datum); const v = per.get(k) ?? { besteed: 0, imp: 0, lk: 0, leads: 0 };
        v.besteed += +r.uitgegeven || 0; v.imp += +r.impressies || 0; v.lk += +(r.link_kliks || 0) || 0; v.leads += +r.leads || 0; per.set(k, v);
      }
      return [...per.entries()].filter(([d, v]) => v.besteed > 0 && d < vandaag).sort(([a], [b]) => a.localeCompare(b));
    };
    const verloop = (reeks: [string, { besteed: number; imp: number; lk: number; leads: number }][]) => {
      const agg = (x: typeof reeks) => x.reduce((t, [, v]) => ({ besteed: t.besteed + v.besteed, imp: t.imp + v.imp, lk: t.lk + v.lk, leads: t.leads + v.leads }), { besteed: 0, imp: 0, lk: 0, leads: 0 });
      const st = agg(reeks.slice(0, 3)), laatst = agg(reeks.slice(-3));
      const w = (a: typeof st) => ({ ctr: r2(a.imp ? a.lk / a.imp : null, 4), cpm: r2(a.imp ? a.besteed / a.imp * 1000 : null), doorzet: r2(a.lk ? a.leads / a.lk : null, 4) });
      return { dagen_met_uitgaven: reeks.length, startwaarde_eerste_3_dagen: reeks.length >= 3 ? w(st) : null, laatste_3_dagen: reeks.length >= 5 ? w(laatst) : null,
        per_dag_laatste_10: reeks.slice(-10).map(([d, v]) => ({ d, besteed: r2(v.besteed), ctr: r2(v.imp ? v.lk / v.imp : null, 4), leads: v.leads })) };
    };
    const dagenLive = (start?: unknown) => start ? Math.max(0, Math.floor((Date.now() - new Date(String(start)).getTime()) / 864e5)) : null;
    const wijzigingen = (naam: string) => (besluiten ?? []).filter((b) => b.besluit === "budget" && b.advertentie === naam && String(b.note || "").includes("aangepast"))
      .map((b) => String(b.created_at).slice(0, 10));

    // ── per campagne → set → advertentie, met afgeleide cijfers en drempelvlaggen ──
    const actief = (s: unknown) => s === "ACTIVE";
    const campagnes = camps.filter((c) => actief(c.effective_status) || (c7.get(String(c.id))?.besteed ?? 0) > 0).map((c) => {
      const cid = String(c.id);
      const cSets = sets.filter((s) => String(s.campaign_id) === cid);
      const cbo = !!(c.daily_budget || c.lifetime_budget);
      return {
        campagne: c.name, status: c.effective_status, budget: cbo ? { niveau: "campagne", dag_eur: c.daily_budget ? Number(c.daily_budget) / 100 : null } : { niveau: "advertentieset" },
        dagen_live: dagenLive(c.start_time), laatste_7_dagen: c7.get(cid) ? metrics(c7.get(cid)!) : null, lifetime: cL.get(cid) ? metrics(cL.get(cid)!) : null,
        verloop: verloop(dagReeks((r) => r.campagne === c.name)),
        advertentiesets: cSets.filter((s) => actief(s.effective_status) || (s7.get(String(s.id))?.besteed ?? 0) > 0).map((s) => {
          const sid = String(s.id), k7 = s7.get(sid), budgetDag = s.daily_budget ? Number(s.daily_budget) / 100 : null;
          const sAds = ads.filter((a) => String(a.adset_id) === sid && (actief(a.effective_status) || (a7.get(String(a.id))?.besteed ?? 0) > 0));
          const adRijen = sAds.map((a) => {
            const aid = String(a.id), m7 = a7.get(aid);
            const m = m7 ? metrics(m7) : null;
            const klikOk = !!m7 && m7.besteed >= 15 && m7.weergaven >= 1000;
            const stopRegel = klikOk && ((m!.ctr ?? 1) < 0.015 || (m!.cpc ?? 0) > 1) && (((m!.cpl ?? 0) > 10) || (m7!.leads === 0 && m7!.besteed >= 20));
            return { _id: aid, _k: m7, advertentie: a.name, status: a.effective_status, dagen_live: dagenLive(a.created_time),
              laatste_7_dagen: m, lifetime: aL.get(aid) ? metrics(aL.get(aid)!) : null,
              genoeg_data: { klik_en_hook: klikOk, cpl_en_doorzet: !!m7 && (dagenLive(a.created_time) ?? 0) >= 3 && m7.leads >= 10 },
              stopregel_geraakt_volgens_code: stopRegel, verloop: verloop(dagReeks((r) => r.campagne === c.name && r.advertentieset === s.name && r.advertentie === a.name)) };
          });
          // significantie tussen advertenties in dezelfde set (§8)
          const vergelijkingen: Record<string, unknown>[] = [];
          for (let i = 0; i < adRijen.length; i++) for (let j = i + 1; j < adRijen.length; j++) {
            const A = adRijen[i]._k, B = adRijen[j]._k; if (!A || !B) continue;
            vergelijkingen.push({ a: adRijen[i].advertentie, b: adRijen[j].advertentie,
              ctr: zToets(A.linkKliks, A.weergaven, B.linkKliks, B.weergaven), doorzet: zToets(A.leads, A.linkKliks, B.leads, B.linkKliks),
              hookrate: zToets(A.v3, A.weergaven, B.v3, B.weergaven), vasthoudrate: zToets(A.thruplays, A.v3, B.thruplays, B.v3) });
          }
          return { advertentieset: s.name, _id: sid, status: s.effective_status, leerfase: (s.learning_stage_info as { status?: string })?.status ?? null,
            dagbudget_eur: budgetDag, dagen_live: dagenLive(s.start_time),
            bestedingsgraad_7d: k7 && budgetDag ? r2(k7.besteed / (budgetDag * 7), 2) : null,
            budget_boven_35: (budgetDag ?? 0) > 35, recente_budgetwijzigingen: wijzigingen(String(s.name)),
            verwachte_leads_per_week: k7 ? k7.leads : null,
            laatste_7_dagen: k7 ? metrics(k7) : null, lifetime: sL.get(sid) ? metrics(sL.get(sid)!) : null,
            verloop: verloop(dagReeks((r) => r.campagne === c.name && r.advertentieset === s.name)),
            aantal_advertenties: adRijen.length, advertenties: adRijen.map(({ _id, _k, ...r }) => r), vergelijkingen };
        }),
      };
    });

    // ── context: Bryans antwoorden op eerdere vragen (o.a. nabelcijfers) ──
    const { data: eerder } = await db.from("mkt_agent_rapport").select("created_at,rapport,antwoord").order("created_at", { ascending: false }).limit(8);
    const antwoorden = (eerder ?? []).filter((r) => (r.antwoord || "").trim())
      .map((r) => `- ${String(r.created_at).slice(0, 10)} · vraag: ${r.rapport?.vraag ?? "?"}\n  antwoord Bryan: ${r.antwoord}`).join("\n") || "nog geen";

    const weekdag = new Date().toLocaleDateString("nl-NL", { weekday: "long", timeZone: "Europe/Amsterdam" });
    const prompt = `Vandaag: ${weekdag} ${vandaag}. Standaardperiode: de laatste 7 dagen (t/m gisteren). Let op als die een weekend bevat.

DATA (JSON; geldbedragen in €, ctr/doorzet/hookrate/vasthoudrate als fractie, null = niet beschikbaar):
${JSON.stringify({ campagnes }, null, 0)}

BRYANS ANTWOORDEN OP EERDERE VRAGEN (o.a. nabelcijfers — gebruik ze):
${antwoorden}

Maak nu de standaardanalyse volgens §13, als JSON in het gevraagde schema. Per waarschuwing precies één concrete actie.
Houd het rapport kort en scanbaar: hooguit 10 waarschuwingen (alleen wat ertoe doet, belangrijkste eerst), reden/diagnose/actie elk hooguit 2 zinnen,
per campagne één toelichting van hooguit 1 zin, alleen campagnes die aanstaan in "campagnes". Liever iets onder "niet_beoordeeld" dan lange uitleg.
Geldbedragen met €-teken en komma (€4,26), percentages met komma (1,68%). Klantnamen mogen (intern rapport).`;

    const claude = new Anthropic({ apiKey });
    const resp = await claude.beta.messages.stream({   // streamen: nodig bij een grote max_tokens
      model: "claude-opus-5-5",
      max_tokens: 40000,   // 16000 was te krap: het rapport werd afgekapt
      thinking: { type: "adaptive" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: INSTRUCTIE,
      output_config: {
        effort: "medium",   // high duurde > 150 s; medium blijft ruim binnen de tijdslimiet van Supabase
        format: { type: "json_schema", schema: {
          type: "object", additionalProperties: false,
          required: ["kort_oordeel", "campagnes", "waarschuwingen", "strategisch_punt", "niet_beoordeeld", "vraag"],
          properties: {
            kort_oordeel: { type: "string" },
            campagnes: { type: "array", items: { type: "object", additionalProperties: false, required: ["campagne", "oordeel", "toelichting"],
              properties: { campagne: { type: "string" }, oordeel: { type: "string", enum: ["Opschalen", "Houden", "Monitoren", "Pauzeren", "Stoppen", "Te vroeg"] }, toelichting: { type: "string" } } } },
            waarschuwingen: { type: "array", items: { type: "object", additionalProperties: false,
              required: ["niveau", "oordeel", "campagne", "reden", "diagnose", "actie"],
              properties: {
                niveau: { type: "string", enum: ["actie_vandaag", "let_op", "goed", "te_vroeg"] },
                oordeel: { type: "string", enum: ["Opschalen", "Houden", "Monitoren", "Pauzeren", "Stoppen", "Te vroeg"] },
                campagne: { type: "string" }, advertentieset: { type: "string" }, advertentie: { type: "string" },
                reden: { type: "string" }, diagnose: { type: "string" }, actie: { type: "string" } } } },
            strategisch_punt: { type: "string" },
            niet_beoordeeld: { type: "array", items: { type: "string" } },
            vraag: { type: "string" },
          } } },
      },
      messages: [{ role: "user", content: prompt }],
    } as never).finalMessage();
    const r = resp as unknown as { stop_reason: string; content: { type: string; text?: string }[] };
    if (r.stop_reason === "refusal") return json({ ok: false, error: "Claude weigerde de analyse" }, 502);
    if (r.stop_reason === "max_tokens") {
      // meld waar de ruimte heen ging, zodat we zien of het denkwerk of de tekst te lang werd
      const tekst = r.content.find((b) => b.type === "text")?.text ?? "";
      const denk = r.content.filter((b) => b.type === "thinking").reduce((t, b) => t + ((b as { thinking?: string }).thinking?.length ?? 0), 0);
      return json({ ok: false, error: `analyse afgekapt (max_tokens) — niets uitgevoerd. Tekens denkwerk: ${denk}, tekens rapport: ${tekst.length}. Einde: …${tekst.slice(-300)}` }, 502);
    }
    const rapport = JSON.parse(r.content.find((b) => b.type === "text")!.text!) as {
      waarschuwingen: { niveau: string; oordeel: string; campagne: string; advertentieset?: string; advertentie?: string; reden: string; actie: string }[] };

    // ── uitvoeren binnen de vangrails ──
    const uitgevoerd: string[] = [];
    let stops = 0;
    for (const w of rapport.waarschuwingen) {
      const camp = campagnes.find((c) => c.campagne === w.campagne);
      const set = camp?.advertentiesets.find((s) => s.advertentieset === w.advertentieset);
      if (w.oordeel === "Stoppen" && w.advertentie && set) {
        const ad = set.advertenties.find((a) => a.advertentie === w.advertentie);
        const metaAd = ads.find((a) => a.name === w.advertentie && sets.find((s) => String(s.id) === String(a.adset_id))?.name === w.advertentieset && actief(a.effective_status));
        if (autoStop && ad?.stopregel_geraakt_volgens_code && metaAd && stops < MAX_STOPS_PER_RUN) {
          const p = await (await fetch(`${GRAPH}/${metaAd.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ status: "PAUSED", access_token: token }) })).json();
          const ok = !p.error; if (ok) { stops++; uitgevoerd.push(`gepauzeerd: ${w.advertentie}`); }
          await db.from("mkt_ad_besluiten").insert({ advertentie: w.advertentie, campagne: w.campagne, besluit: "stop", status: "open", door: "Claude-agent",
            note: `🤖 ${ok ? "Automatisch gepauzeerd" : "Pauzeren mislukt: " + p.error?.message}. ${w.reden} Doen: ${w.actie}` });
        }
      }
      if (w.oordeel === "Pauzeren" && set && !w.advertentie) {
        const s7 = set.laatste_7_dagen, budget = set.dagbudget_eur;
        const regel = !!s7 && (s7.besteed ?? 0) >= 50 && (s7.cpl ?? 0) > 10 && (set.dagen_live ?? 0) >= 3;
        const rust = !(besluiten ?? []).some((b) => b.besluit === "budget" && b.advertentie === set.advertentieset && String(b.note || "").includes("aangepast") &&
          Date.now() - new Date(b.created_at).getTime() < BUDGET_RUST_UUR * 3600e3);
        if (autoBudget && regel && rust && budget && budget > PAUZE_BUDGET_EUR) {
          const p = await (await fetch(`${GRAPH}/${set._id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ daily_budget: String(PAUZE_BUDGET_EUR * 100), access_token: token }) })).json();
          const ok = !p.error; if (ok) uitgevoerd.push(`budget ${set.advertentieset}: €${budget} → €${PAUZE_BUDGET_EUR}`);
          await db.from("mkt_ad_besluiten").insert({ advertentie: set.advertentieset, campagne: w.campagne, besluit: "budget", status: "open", door: "Claude-agent",
            note: `🤖 ${ok ? `Dagbudget aangepast: €${budget} → €${PAUZE_BUDGET_EUR} (pauzeren)` : "Budget aanpassen mislukt: " + p.error?.message}. ${w.reden}` });
        }
      }
    }

    const { error: re } = await db.from("mkt_agent_rapport").insert({ rapport, uitgevoerd, model: "claude-opus-5-5" });
    return json({ ok: true, opgeslagen: !re, fout_opslaan: re?.message, autoStop, autoBudget, waarschuwingen: rapport.waarschuwingen.length, uitgevoerd });
    })().catch((e) => json({ error: String(e) }, 500));
    EdgeRuntime.waitUntil(run.then(async (res) => {
      if (res.ok) return;
      const b = await res.json().catch(() => ({}));
      await db.from("mkt_agent_rapport").insert({ rapport: { fout: b.error ?? `status ${res.status}` }, model: "claude-opus-5-5" });
    }));
    return json({ ok: true, gestart: true }, 202);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
