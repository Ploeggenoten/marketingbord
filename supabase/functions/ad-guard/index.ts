// ═══ AD-GUARD v3 · Claude-mediabuyer-agent (2·1·5-kader) ═══
// Analyseert de volledige accountstructuur (campagne=klant, set=functie, ad=hook)
// volgens het 2·1·5-kader van Ploeggenoten: link-CTR > 2%, link-CPC < €1, CPL < €5.
//  1. Per set en per advertentie een 2·1·5-oordeel (in code berekend, zie oordeel215)
//  2. Falende advertenties (kill-trigger) → stop-advies of automatische pauze
//  3. Budget per advertentieset → bijschalen/afschalen-advies of automatische
//     aanpassing (alleen ABO-sets, geclamped, met cooldown)
//  4. Creative-oordeel: houden / hook aanpassen / nieuwe video / nieuwe flyer,
//     met briefing van vier regels
//  5. Na-de-klik-problemen (goede CTR, hoge CPL) → formulier/doelgroep nakijken
//  6. Hook-verdeling en structuur (CBO/ABO, leerfase)
// Claude (Opus 5.5) beoordeelt het geheel en geeft onderbouwde adviezen; de
// vangrails hieronder bepalen wat er ook echt wordt uitgevoerd.
//
// VANGRAILS (hard, in code — niet aan het model overgelaten):
//  - Alleen PAUZEREN van ads en DAGBUDGET van ABO-sets wijzigen; nooit
//    verwijderen, nooit campagnebudgetten, nooit targeting/creative.
//  - Stops alleen als config __auto_stop__ = aan; budget alleen als
//    __auto_budget__ = aan. Beide staan standaard UIT (schakelaars in de app).
//  - Automatisch pauzeren alleen als de advertentie in code de 2·1·5-kill-trigger
//    raakt (≥ €15 én ≥ 1.000 weergaven, en link-CTR < 1,5% of link-CPC > €1).
//  - Automatisch bijschalen alleen als de set in code op "schalen" staat
//    (alles op norm, ≥ 3 dagen live, ≥ 10 leads). Afschalen mag altijd binnen de clamp.
//  - Budget: max ±20% per wijziging, min €5/dag, totaal dagbudget van het
//    account mag per run niet stijgen, max 1 wijziging per set per 48 uur.
//  - Max 2 ad-stops per run. 'negeer'-besluiten 7 dagen gerespecteerd.
//  - Alles gelogd in mkt_ad_besluiten met reden.
// Secrets: META_ACCESS_TOKEN (+ads_management voor uitvoeren), META_AD_ACCOUNT_ID,
// ANTHROPIC_API_KEY, CRON_SECRET.
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_STOPS_PER_RUN = 2;
const MAX_BUDGET_STAP = 0.20;      // ±20% per stap (onderzoek 21 jul 2026; groter = 2 stappen met 48u)
const MIN_DAGBUDGET_EUR = 5;
const BUDGET_COOLDOWN_UUR = 48;

// ── 2·1·5-kader (Ploeggenoten-beleid) ──
const NORM_CTR = 0.02;             // link-CTR boven 2%
const NORM_CPC = 1;                // link-CPC onder €1
const NORM_CPL = 5;                // CPL onder €5
const KILL_CTR = 0.015;            // kill-trigger: link-CTR onder 1,5% (of CPC boven NORM_CPC)
const DREMPEL_SPEND = 15;          // pas te beoordelen vanaf €15 besteed…
const DREMPEL_IMP = 1000;          // …én 1.000 weergaven
const SCHAAL_DAGEN = 3;            // schalen vanaf 3 dagen live…
const SCHAAL_LEADS = 10;           // …en 10 leads

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Row = { datum: string; campagne: string; advertentieset: string; advertentie: string; uitgegeven: number; impressies: number; kliks: number; link_kliks: number; leads: number };
function stats(rows: Row[]) {
  const s = { spend: 0, imp: 0, linkKliks: 0, leads: 0 };
  for (const r of rows) { s.spend += +r.uitgegeven || 0; s.imp += +r.impressies || 0; s.linkKliks += +r.link_kliks || 0; s.leads += +r.leads || 0; }
  return { ...s, cpc: s.linkKliks ? s.spend / s.linkKliks : null, ctr: s.imp ? s.linkKliks / s.imp : null, cpl: s.leads ? s.spend / s.leads : null };
}
type Stats = ReturnType<typeof stats>;
// Aantal dagen met uitgaven = hoe lang iets (binnen het 30d-venster) echt live is.
const dagenLive = (rows: Row[]) => new Set(rows.filter((r) => +r.uitgegeven > 0).map((r) => r.datum)).size;

// Beslisboom uit het 2·1·5-kader. Dezelfde uitkomst stuurt de prompt én de vangrails.
type Oordeel = "te_vroeg" | "kill" | "na_de_klik" | "houden" | "schalen";
function oordeel215(s: Stats, dagen: number): Oordeel {
  if (s.spend < DREMPEL_SPEND || s.imp < DREMPEL_IMP) return "te_vroeg";
  if ((s.ctr ?? 0) < KILL_CTR || s.cpc == null || s.cpc > NORM_CPC) return "kill";
  if (s.cpl == null || s.cpl > NORM_CPL) return "na_de_klik"; // geen leads boven de drempel = CPL ver boven norm
  if (s.leads < SCHAAL_LEADS || dagen < SCHAAL_DAGEN) return "houden";
  return "schalen";
}
const OORDEEL_TEKST: Record<Oordeel, string> = {
  te_vroeg: "TE VROEG (onder €15 of 1.000 weergaven — laten lopen)",
  kill: "KILL-TRIGGER (link-CTR < 1,5% of link-CPC > €1)",
  na_de_klik: "NA-DE-KLIK (klikken op norm, CPL > €5 — formulier/doelgroep)",
  houden: "HOUDEN (op norm, nog te weinig volume)",
  schalen: "SCHALEN (op norm, ≥ 3 dagen, ≥ 10 leads)",
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const eur = (n: number | null | undefined) => n == null ? "?" : "€" + Number(n).toFixed(2);
const pct = (n: number | null | undefined) => n == null ? "?" : (n * 100).toFixed(2) + "%";
const kpi = (s: Stats) => `${eur(s.spend)}, ${s.imp} weergaven, ${s.leads} leads, link-CTR ${pct(s.ctr)}, link-CPC ${eur(s.cpc)}, CPL ${s.cpl ? eur(s.cpl) : (s.spend ? "geen leads" : "?")}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // ── toegang: cron of ingelogd teamlid ──
    const cronSecret = Deno.env.get("CRON_SECRET");
    const isCron = !!cronSecret && req.headers.get("x-cron-key") === cronSecret;
    if (!isCron) {
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
      );
      const { data: { user } } = await authClient.auth.getUser();
      if (!user) return json({ error: "geen toegang — log in" }, 403);
    }
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // ── schakelaars (standaard UIT) ──
    const { data: cfg } = await db.from("mkt_ad_besluiten").select("advertentie,besluit,created_at")
      .in("advertentie", ["__auto_stop__", "__auto_budget__"]).order("created_at", { ascending: false });
    const laatste = (k: string) => (cfg ?? []).find((c) => c.advertentie === k)?.besluit === "aan";
    const autoStop = laatste("__auto_stop__");
    const autoBudget = laatste("__auto_budget__");

    // ── data: stats uit db + live budgetten uit Meta ──
    const cut30 = daysAgo(30);
    // Vandaag bewust NIET meenemen: de lopende dag is halve data (leads komen later binnen
    // dan de klik) en zou de agent 's ochtends structureel te somber maken.
    const vandaag = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" });
    const { data: metaRows } = await db.from("mkt_meta_stats").select("*")
      .gte("datum", cut30).lt("datum", vandaag);
    const { data: besluiten } = await db.from("mkt_ad_besluiten").select("*")
      .not("advertentie", "like", "\\_\\_%");
    if (!metaRows?.length) return json({ ok: true, melding: "geen advertentiedata" });

    // Link-klikken bestaan pas sinds migratie-linkkliks.sql + nieuwe meta-sync. Zolang die
    // nog niet gevuld zijn, valt het 2·1·5-kader niet toe te passen: dan geen kill/schaal-
    // oordelen en geen automatische acties — alleen advies met die waarschuwing.
    const linkDataOk = (metaRows as Row[]).some((r) => +r.link_kliks > 0) ||
      !(metaRows as Row[]).some((r) => +r.kliks > 0);

    const token = Deno.env.get("META_ACCESS_TOKEN")!;
    let account = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
    if (!account.startsWith("act_")) account = "act_" + account;

    const q = async (path: string) =>
      await (await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`)).json();
    const campagnesResp = await q(`${account}/campaigns?fields=id,name,daily_budget,lifetime_budget,effective_status&limit=200`);
    const adsetsResp = await q(`${account}/adsets?fields=id,name,daily_budget,lifetime_budget,campaign{name},effective_status,learning_stage_info&limit=500`);
    const adsResp = await q(`${account}/ads?fields=id,name,adset{name},campaign{name},effective_status&limit=500`);
    if (campagnesResp.error || adsetsResp.error) {
      return json({ error: "Meta API: " + (campagnesResp.error?.message || adsetsResp.error?.message) }, 502);
    }
    type MetaSet = { id: string; name: string; daily_budget?: string; lifetime_budget?: string; campaign?: { name: string }; effective_status: string; learning_stage_info?: { status?: string } };
    const liveSets = (adsetsResp.data ?? []) as MetaSet[];
    const liveCamps = (campagnesResp.data ?? []) as { id: string; name: string; daily_budget?: string; effective_status: string }[];
    const liveAds = (adsResp.data ?? []) as { id: string; name: string; adset?: { name: string }; campaign?: { name: string }; effective_status: string }[];

    // ── overzicht bouwen per campagne → set → hook, met 2·1·5-oordeel ──
    const d7 = daysAgo(7), d14 = daysAgo(14);
    const rows = metaRows as Row[];
    const acc30 = stats(rows);
    const acc7 = stats(rows.filter((r) => r.datum >= d7));

    const perCamp = new Map<string, Map<string, Row[]>>();
    for (const r of rows) {
      if (!perCamp.has(r.campagne)) perCamp.set(r.campagne, new Map());
      const sets = perCamp.get(r.campagne)!;
      const setKey = r.advertentieset || "—";
      if (!sets.has(setKey)) sets.set(setKey, []);
      sets.get(setKey)!.push(r);
    }

    // Oordelen per set/ad (key = campagne|set[|ad]) — gebruikt door de vangrails.
    const setOordeel = new Map<string, Oordeel>();
    const adOordeel = new Map<string, Oordeel>();
    // Start-CTR = link-CTR over de eerste 4 live dagen; zakt de huidige CTR daar ver
    // onder bij oplopende frequentie, dan is dat slijtage (niet: zwak concept).
    const startCtr = (rs: Row[]) => {
      const dagen = [...new Set(rs.filter((r) => +r.uitgegeven > 0).map((r) => r.datum))].sort().slice(0, 4);
      return stats(rs.filter((r) => dagen.includes(r.datum))).ctr;
    };

    let overzicht = "";
    for (const [campNaam, sets] of perCamp) {
      const liveCamp = liveCamps.find((c) => c.name === campNaam);
      const isCBO = !!(liveCamp?.daily_budget);
      const cActief = liveCamp?.effective_status === "ACTIVE";
      overzicht += `\n## Campagne "${campNaam}" ${cActief ? "" : `[${liveCamp?.effective_status ?? "onbekend"}]`} — budget: ${isCBO ? `CBO ${eur(Number(liveCamp!.daily_budget) / 100)}/dag op campagneniveau` : "ABO (budget per set)"}\n`;
      for (const [setNaam, setRows] of sets) {
        const ls = liveSets.find((s) => s.name === setNaam && (s.campaign?.name ?? "") === campNaam);
        const s7 = stats(setRows.filter((r) => r.datum >= d7));
        const sPrev = stats(setRows.filter((r) => r.datum >= d14 && r.datum < d7));
        const s30 = stats(setRows);
        const dagen = dagenLive(setRows);
        const o = linkDataOk ? oordeel215(s7, dagen) : "te_vroeg";
        setOordeel.set(`${campNaam}|${setNaam}`, o);
        const budget = ls?.daily_budget ? `${eur(Number(ls.daily_budget) / 100)}/dag` : (isCBO ? "via CBO" : "onbekend");
        const leer = ls?.learning_stage_info?.status ? ` leerfase:${ls.learning_stage_info.status}` : "";
        overzicht += `- Set "${setNaam}" [${ls?.effective_status ?? "?"}${leer}] budget ${budget}, ${dagen} dagen live\n` +
          `    2·1·5-oordeel (7d): ${OORDEEL_TEKST[o]}\n` +
          `    7d: ${kpi(s7)}\n    vorige 7d: ${kpi(sPrev)}\n    30d: ${kpi(s30)} · start-CTR (eerste 4 live dagen): ${pct(startCtr(setRows))}\n`;
        // hooks binnen de set (7d) — impressie-aandeel + eigen 2·1·5-oordeel
        const perAd = new Map<string, Row[]>();
        for (const r of setRows) {
          if (!perAd.has(r.advertentie)) perAd.set(r.advertentie, []);
          perAd.get(r.advertentie)!.push(r);
        }
        const totImp = [...perAd.values()].reduce((t, a) => t + stats(a.filter((r) => r.datum >= d7)).imp, 0) || 1;
        for (const [adNaam, adRows] of perAd) {
          const a7 = stats(adRows.filter((r) => r.datum >= d7));
          if (!a7.imp) continue; // niet getoond in de laatste 7 dagen
          const ao = linkDataOk ? oordeel215(a7, dagenLive(adRows)) : "te_vroeg";
          adOordeel.set(`${campNaam}|${setNaam}|${adNaam}`, ao);
          const liveAd = liveAds.find((x) => x.name === adNaam && (x.adset?.name ?? "") === setNaam);
          overzicht += `    · hook "${adNaam}" [${liveAd?.effective_status ?? "?"}] ${(a7.imp / totImp * 100).toFixed(0)}% van set-weergaven, ${dagenLive(adRows)} dagen live — ${OORDEEL_TEKST[ao]}\n` +
            `        7d: ${kpi(a7)} · start-CTR: ${pct(startCtr(adRows))}\n`;
        }
      }
    }

    const recenteBesluiten = (besluiten ?? []).slice(0, 15).map((b) =>
      `- ${b.created_at?.slice(0, 10)} ${b.besluit} "${b.advertentie}" (${b.status}, door ${b.door})`).join("\n") || "geen";

    // ── Claude: integrale mediabuyer-analyse ──
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY nog niet ingesteld als secret" }, 500);
    const claude = new Anthropic({ apiKey });

    const prompt = `Je bent de mediabuyer-agent van Ploeggenoten, een klein Nederlands recruitmentbureau (productie/logistiek/techniek). Je zit dagelijks in Ads Manager, leest de cijfers zoals ze zijn en verbindt er een besluit aan. Structuur: campagne = klant, advertentieset = functie waarvoor geworven wordt, advertentie = hook (video of flyer). Eén plaatsing is duizenden euro's fee waard; leads zijn sollicitaties via een leadformulier, dus CPL = kosten per resultaat.
${linkDataOk ? "" : `
LET OP: de link-klikken zijn nog niet gesynchroniseerd (migratie of nieuwe meta-sync nog niet gedraaid). Link-CTR en link-CPC staan daardoor op 0/?. Trek GEEN conclusies over creatives of kill-triggers; geef hooguit structuur-advies en meld in één advies (type "structuur") dat de sync eerst moet draaien.
`}
ACCOUNTOVERZICHT (laatste 30 dagen, vandaag niet meegeteld; 7d = laatste 7 dagen):
Account 7d: ${kpi(acc7)} · 30d: ${kpi(acc30)}
${overzicht}
Recente besluiten (niet herhalen, cooldowns respecteren):
${recenteBesluiten}

HET BEOORDELINGSKADER: 2 · 1 · 5 — percentages omhoog, euro's omlaag.
- Link-CTR boven 2% · link-CPC onder €1 · CPL onder €5. Dit is de ruggengraat van elk oordeel. CPM en frequentie zijn geen normen maar verklaringen.
- Het 2·1·5-oordeel per set en hook is hierboven al in code berekend volgens de beslisboom. Neem het over; wijk alleen af als de context (leerfase, recente besluiten, slijtage) daar een duidelijke reden voor geeft, en zeg dan waarom.
- Beslisboom: (1) onder €15 of 1.000 weergaven → te vroeg, laten lopen, niets veranderen. (2) kill-trigger: link-CTR < 1,5% of link-CPC > €1 → stoppen of vervangen; bij lage CTR is de creative het probleem, niet het budget. (3) CPL > €5 maar CTR en CPC op norm → probleem zit ná de klik: formulier, vraagstelling of doelgroep — NIET de creative vervangen. (4) op norm maar < 10 leads of < 3 dagen live → houden. (5) op norm, ≥ 3 dagen, ≥ 10 leads → schalen met max 20% per keer, om de 2–3 dagen.
- Pauzeren van een SET betekent: dagbudget terug naar €8–10, niet uitzetten (dan blijft de leerhistorie bewaard). Uitzetten doe je alleen met losse advertenties (hooks).

DIAGNOSE — koppel elk oordeel aan een oorzaak:
- Lage link-CTR → de hook pakt niet (eerste seconden / eerste beeld). Actie: nieuwe hook testen, niet het budget aanpassen.
- Goede CTR, hoge CPC → veel concurrentie of smalle doelgroep (kijk naar CPM).
- Goede CTR, hoge CPL → mensen haken af in het formulier. Laat checken of Flexible Form Display op Handmatig staat (niet Geoptimaliseerd — dan vallen de filtervragen weg).
- CTR die zakt t.o.v. de start-CTR terwijl het al een tijd loopt → advertentiemoeheid: nieuwe creative, dezelfde set.

CREATIVE-OORDEEL — apart van het budgetbesluit, kies de kleinste ingreep:
- Alleen de klikkant (link-CTR) wijst naar de creative. CTR op norm + CPL te hoog = geen creative-probleem.
- CTR was nooit goed → concept klopt niet → nieuwe video, nieuwe invalshoek.
- CTR was goed (start-CTR) en zakt nu → slijtage → nieuwe hook op bestaand materiaal (andere eerste 3 seconden, openingszin, scènevolgorde). Pas opnieuw filmen als een tweede hook-variant ook niet aanslaat.
- CTR verschilt sterk tussen hooks in dezelfde set → geen productie nodig: winnaar doorschalen, verliezer eruit.
- Video als de vacature uitleg vraagt (het werk, de ploeg, waarom daar werken) — met echte medewerkers op locatie, geen acteur. Flyer/statisch als het snel moet of de boodschap kort is (één voorwaarde, één arbeidsvoorwaarde, één regio); staat binnen een dag live.
- Draaien er in een set alleen video's of alleen statics en zakt de CTR → eerst het andere formaat testen.
- Bij "nieuwe video", "nieuwe flyer" of "hook aanpassen" ALTIJD een briefing van vier regels: vacature · formaat · motivatie van de kandidaat die centraal staat · welke hook getest wordt tegen wat er nu draait.

OVERIGE SPEELREGELS (geverifieerd onderzoek 21 jul 2026):
- LEERFASE: een set verlaat de leerfase na ~50 leads binnen 7 dagen. Bij dit budget (€500-3000/mnd) kunnen maar 1-3 sets tegelijk echt leren. Veel dunne sets = versnippering. "Learning limited" → adviseer samenvoegen; kleine functies bundelen. Geen budget-edits aan sets in de leerfase.
- CBO verdeelt bewust niet eerlijk; voor eerlijke verdeling per functie: ABO. "Ad Set Budget Sharing" uitzetten als eerlijke verdeling het doel is.
- HOOK-TESTEN: nieuwe hooks hongeren binnen ~48u uit naast een bewezen winnaar. Aanpak: kleine aparte ABO-testcampagne, één hook per set, vast budget; winnaar daarna in de hoofdcampagne via post-ID-hergebruik. Hooks met < 10% van de set-weergaven na ≥ 4 dagen zijn feitelijk ongetest.
- Frequente budgetwijzigingen resetten het leren: liever één goed getimede wijziging dan dagelijks schuiven.
- Attributie loopt 1-2 dagen achter. Geen advies is beter dan een zwak advies. Is iets niet te beoordelen, zeg dat ("nog niet te zeggen") in plaats van te gokken.

Geef je adviezen. Types:
- "stop_ad": advertentie (hook) uitzetten — alleen bij een kill-trigger
- "budget_set": nieuw dagbudget voor een ABO-set (geef nieuw_dagbudget_eur) — schalen, of pauzeren naar €8–10
- "creative": creative-besluit voor een set (geef creative_actie en, behalve bij "winnaar_doorschalen", een briefing)
- "na_de_klik": CPL te hoog bij goede CTR/CPC → formulier, vraagstelling of doelgroep nakijken
- "hook_test": hooks die geen eerlijke kans krijgen + concrete testaanpak
- "structuur": advies over hoe de campagnes/budgetten zijn opgezet
Geef bij elk advies over een set het oordeel in één woord (Schalen / Houden / Pauzeren / Stoppen / Te vroeg).
Rangschik de adviezen op hoeveel geld ermee gemoeid is, grootste eerst.

SCHRIJFSTIJL — Bryan (marketeer) leest dit:
- Zakelijk en direct, gewone-mensen-Nederlands, korte zinnen. Een set die niet werkt heet gewoon een set die niet werkt; geen "mooie trend" of "geweldige resultaten".
- De 2·1·5-termen link-CTR, link-CPC en CPL mag je gebruiken (dat is Bryans eigen kader), altijd met eenheid en Nederlandse notatie: "2,7% link-CTR", "€0,84 link-CPC", "€3,42 CPL". Overige vaktermen (CBO/ABO, CPA, CPM, leerfase, post-ID) vertaal je: "budget staat op de campagne / op de functie", "de periode waarin Meta nog leert".
- Noem klanten zoals de campagne heet.
- Sluit ELK advies af met één concrete zin die begint met "Doen: …" — precies wat Bryan nu moet klikken of maken. De briefing staat apart in het veld briefing.
- Max 3 zinnen per advies (exclusief briefing).
Voorbeeld: "Deze hook staat na €22 op 0,9% link-CTR — ruim onder de 1,5%-grens; de eerste seconden pakken niet. De andere hook in deze set doet 2,6%. Doen: zet deze advertentie uit in Ads Manager."
vertrouwen: hoog/middel/laag.`;

    const resp = await claude.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // Opus 5.5 staat standaard op effort "medium"; budgetbesluiten verdienen "high".
      // Weigert de veiligheidsfilter onterecht, dan draait Anthropic de vraag op een
      // aanbevolen ander model (fallbacks: "default") in plaats van dat de run mislukt.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: "high",
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              adviezen: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    type: { type: "string", enum: ["stop_ad", "budget_set", "creative", "na_de_klik", "hook_test", "structuur"] },
                    campagne: { type: "string" },
                    advertentieset: { type: "string" },
                    advertentie: { type: "string" },
                    oordeel: { type: "string", enum: ["Schalen", "Houden", "Pauzeren", "Stoppen", "Te vroeg"] },
                    nieuw_dagbudget_eur: { type: "number" },
                    creative_actie: { type: "string", enum: ["houden", "hook_aanpassen", "nieuwe_video", "nieuwe_flyer", "ander_formaat_testen", "winnaar_doorschalen"] },
                    briefing: { type: "string" },
                    reden: { type: "string" },
                    vertrouwen: { type: "string", enum: ["hoog", "middel", "laag"] },
                  },
                  required: ["type", "campagne", "reden", "vertrouwen"],
                  additionalProperties: false,
                },
              },
            },
            required: ["adviezen"],
            additionalProperties: false,
          },
        },
      },
      messages: [{ role: "user", content: prompt }],
    });
    if (resp.stop_reason === "refusal") return json({ ok: false, error: "Claude weigerde de analyse" }, 502);
    if (resp.stop_reason === "max_tokens") return json({ ok: false, error: "analyse afgekapt (max_tokens) — niets uitgevoerd" }, 502);
    const txt = resp.content.find((b) => b.type === "text") as { text: string };
    type Advies = { type: string; campagne: string; advertentieset?: string; advertentie?: string; oordeel?: string; nieuw_dagbudget_eur?: number; creative_actie?: string; briefing?: string; reden: string; vertrouwen: string };
    const { adviezen } = JSON.parse(txt.text) as { adviezen: Advies[] };
    const kop = (adv: Advies) => adv.oordeel ? `[${adv.oordeel}] ` : "";

    // ── uitvoeren binnen vangrails + alles loggen ──
    const totaalBudgetVoor = liveSets.reduce((t, s) => t + (Number(s.daily_budget) || 0), 0) / 100;
    let totaalBudgetNa = totaalBudgetVoor;
    let stops = 0;
    const resultaten: Record<string, unknown>[] = [];

    for (const adv of adviezen) {
      let uitgevoerd = false, detail = "";

      if (adv.type === "stop_ad" && adv.advertentie) {
        const alGedaan = (besluiten ?? []).some((b) => b.advertentie === adv.advertentie && b.besluit === "stop" && b.status !== "bevestigd");
        // 2·1·5-vangrail: alleen automatisch pauzeren als de code de kill-trigger ook ziet.
        const killInCode = [...adOordeel].some(([k, o]) => o === "kill" &&
          k.startsWith(`${adv.campagne}|`) && k.endsWith(`|${adv.advertentie}`) &&
          (!adv.advertentieset || k === `${adv.campagne}|${adv.advertentieset}|${adv.advertentie}`));
        if (!killInCode) detail = "geen 2·1·5-kill-trigger in de cijfers — alleen advies";
        if (!alGedaan && autoStop && killInCode && adv.vertrouwen === "hoog" && stops < MAX_STOPS_PER_RUN) {
          const doelen = liveAds.filter((a) => a.name === adv.advertentie &&
            (!adv.advertentieset || (a.adset?.name ?? "") === adv.advertentieset) && a.effective_status === "ACTIVE");
          for (const ad of doelen) {
            const p = await fetch(`${GRAPH}/${ad.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ status: "PAUSED", access_token: token }) });
            const pj = await p.json();
            if (pj.error) detail = pj.error.message; else uitgevoerd = true;
          }
          if (uitgevoerd) stops++;
        }
        if (!alGedaan) await db.from("mkt_ad_besluiten").insert({
          advertentie: adv.advertentie, campagne: adv.campagne, besluit: "stop", status: "open",
          door: "Claude-agent", note: `🤖 ${kop(adv)}${uitgevoerd ? "Automatisch gepauzeerd" : "Stop-advies" + (detail ? ` (niet automatisch: ${detail})` : autoStop ? "" : " (auto-stop staat uit)")}. ${adv.reden}`,
        });
      }

      else if (adv.type === "budget_set" && adv.advertentieset && adv.nieuw_dagbudget_eur) {
        const ls = liveSets.find((s) => s.name === adv.advertentieset && (s.campaign?.name ?? "") === adv.campagne);
        const huidigEur = ls?.daily_budget ? Number(ls.daily_budget) / 100 : null;
        let doelEur = adv.nieuw_dagbudget_eur;
        let kanUitvoeren = autoBudget && adv.vertrouwen !== "laag" && !!ls && huidigEur != null;
        if (kanUitvoeren) {
          // clamp ±20%, min €5, cooldown 48u, totaal mag niet stijgen
          doelEur = Math.max(MIN_DAGBUDGET_EUR, Math.min(huidigEur! * (1 + MAX_BUDGET_STAP), Math.max(huidigEur! * (1 - MAX_BUDGET_STAP), doelEur)));
          const cutCooldown = new Date(Date.now() - BUDGET_COOLDOWN_UUR * 3600e3).toISOString();
          const recent = (besluiten ?? []).some((b) => b.besluit === "budget" && b.advertentie === adv.advertentieset && b.created_at > cutCooldown);
          if (ls!.learning_stage_info?.status === "LEARNING") { kanUitvoeren = false; detail = "set zit in de leerfase — Meta adviseert dan geen budget-edits"; }
          else if (doelEur > huidigEur! && setOordeel.get(`${adv.campagne}|${adv.advertentieset}`) !== "schalen") { kanUitvoeren = false; detail = "set staat volgens 2·1·5 (nog) niet op schalen"; }
          else if (recent) { kanUitvoeren = false; detail = "cooldown 48u"; }
          else if (totaalBudgetNa - huidigEur! + doelEur > totaalBudgetVoor + 0.01) { kanUitvoeren = false; detail = "totaalbudget zou stijgen — alleen Bryan/Tjeerd verhogen het plafond"; }
        }
        if (kanUitvoeren) {
          const p = await fetch(`${GRAPH}/${ls!.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ daily_budget: String(Math.round(doelEur * 100)), access_token: token }) });
          const pj = await p.json();
          if (pj.error) detail = pj.error.message; else { uitgevoerd = true; totaalBudgetNa = totaalBudgetNa - huidigEur! + doelEur; }
        }
        await db.from("mkt_ad_besluiten").insert({
          advertentie: adv.advertentieset, campagne: adv.campagne, besluit: "budget", status: "open",
          door: "Claude-agent", note: `🤖 ${kop(adv)}${uitgevoerd ? `Dagbudget aangepast: ${eur(huidigEur)} → ${eur(doelEur)}` : `Budget-advies: ${eur(huidigEur)} → ${eur(adv.nieuw_dagbudget_eur)}${detail ? ` (niet uitgevoerd: ${detail})` : autoBudget ? "" : " (auto-budget staat uit)"}`}. ${adv.reden}`,
        });
      }

      else { // creative / na_de_klik / hook_test / structuur → altijd alleen advies
        const label = ({ creative: "creative", na_de_klik: "na de klik", hook_test: "hook-test" } as Record<string, string>)[adv.type] ?? "structuur";
        const actie = adv.creative_actie ? ` ${adv.creative_actie.replaceAll("_", " ")}:` : "";
        const briefing = adv.briefing ? `\nBriefing: ${adv.briefing}` : "";
        await db.from("mkt_ad_besluiten").insert({
          advertentie: adv.advertentie || adv.advertentieset || adv.campagne, campagne: adv.campagne,
          besluit: "advies", status: "open", door: "Claude-agent",
          note: `🤖 [${label}] ${kop(adv)}${actie} ${adv.reden}${briefing}`,
        });
      }
      resultaten.push({ ...adv, uitgevoerd, detail: detail || undefined });
    }

    return json({ ok: true, autoStop, autoBudget, linkDataOk, adviezen: adviezen.length, gestopt: stops,
      budgetVoor: totaalBudgetVoor, budgetNa: totaalBudgetNa, resultaten });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
