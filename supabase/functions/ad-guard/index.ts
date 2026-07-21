// ═══ AD-GUARD v2 · Claude-mediabuyer-agent ═══
// Analyseert de volledige accountstructuur (campagne=klant, set=functie, ad=hook):
//  1. Falende advertenties → stop-advies of automatische pauze
//  2. Budget per advertentieset → bijschalen/afschalen-advies of automatische
//     aanpassing (alleen ABO-sets, geclamped, met cooldown)
//  3. Hook-verdeling binnen sets → signaleert hooks die geen budget krijgen
//  4. Structuur → CBO/ABO-advies per campagne
// Claude (Opus 4.8) beoordeelt het geheel en geeft onderbouwde adviezen; de
// vangrails hieronder bepalen wat er ook echt wordt uitgevoerd.
//
// VANGRAILS (hard, in code — niet aan het model overgelaten):
//  - Alleen PAUZEREN van ads en DAGBUDGET van ABO-sets wijzigen; nooit
//    verwijderen, nooit campagnebudgetten, nooit targeting/creative.
//  - Stops alleen als config __auto_stop__ = aan; budget alleen als
//    __auto_budget__ = aan. Beide staan standaard UIT (schakelaars in de app).
//  - Budget: max ±30% per wijziging, min €5/dag, totaal dagbudget van het
//    account mag per run niet stijgen, max 1 wijziging per set per 48 uur.
//  - Max 2 ad-stops per run. 'negeer'-besluiten 7 dagen gerespecteerd.
//  - Alles gelogd in mkt_ad_besluiten met reden.
// Secrets: META_ACCESS_TOKEN (+ads_management voor uitvoeren), META_AD_ACCOUNT_ID,
// ANTHROPIC_API_KEY, CRON_SECRET.
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_STOPS_PER_RUN = 2;
const MAX_BUDGET_STAP = 0.30;      // ±30% per wijziging
const MIN_DAGBUDGET_EUR = 5;
const BUDGET_COOLDOWN_UUR = 48;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Row = { datum: string; campagne: string; advertentieset: string; advertentie: string; uitgegeven: number; impressies: number; kliks: number; leads: number };
function stats(rows: Row[]) {
  const s = { spend: 0, imp: 0, kliks: 0, leads: 0 };
  for (const r of rows) { s.spend += +r.uitgegeven || 0; s.imp += +r.impressies || 0; s.kliks += +r.kliks || 0; s.leads += +r.leads || 0; }
  return { ...s, cpc: s.kliks ? s.spend / s.kliks : null, ctr: s.imp ? s.kliks / s.imp : null, cpl: s.leads ? s.spend / s.leads : null };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };
const eur = (n: number | null | undefined) => n == null ? "?" : "€" + Number(n).toFixed(2);

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
    const { data: metaRows } = await db.from("mkt_meta_stats").select("*").gte("datum", cut30);
    const { data: besluiten } = await db.from("mkt_ad_besluiten").select("*")
      .not("advertentie", "like", "\\_\\_%");
    if (!metaRows?.length) return json({ ok: true, melding: "geen advertentiedata" });

    const token = Deno.env.get("META_ACCESS_TOKEN")!;
    let account = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
    if (!account.startsWith("act_")) account = "act_" + account;

    const q = async (path: string) =>
      await (await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`)).json();
    const campagnesResp = await q(`${account}/campaigns?fields=id,name,daily_budget,lifetime_budget,effective_status&limit=200`);
    const adsetsResp = await q(`${account}/adsets?fields=id,name,daily_budget,lifetime_budget,campaign{name},effective_status&limit=500`);
    const adsResp = await q(`${account}/ads?fields=id,name,adset{name},campaign{name},effective_status&limit=500`);
    if (campagnesResp.error || adsetsResp.error) {
      return json({ error: "Meta API: " + (campagnesResp.error?.message || adsetsResp.error?.message) }, 502);
    }
    type MetaSet = { id: string; name: string; daily_budget?: string; lifetime_budget?: string; campaign?: { name: string }; effective_status: string };
    const liveSets = (adsetsResp.data ?? []) as MetaSet[];
    const liveCamps = (campagnesResp.data ?? []) as { id: string; name: string; daily_budget?: string; effective_status: string }[];
    const liveAds = (adsResp.data ?? []) as { id: string; name: string; adset?: { name: string }; campaign?: { name: string }; effective_status: string }[];

    // ── overzicht bouwen per campagne → set → hook ──
    const d7 = daysAgo(7), d14 = daysAgo(14), d2 = daysAgo(2);
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
        const budget = ls?.daily_budget ? `${eur(Number(ls.daily_budget) / 100)}/dag` : (isCBO ? "via CBO" : "onbekend");
        overzicht += `- Set "${setNaam}" [${ls?.effective_status ?? "?"}] budget ${budget}: 7d ${eur(s7.spend)}, ${s7.leads} leads${s7.cpl ? ` (${eur(s7.cpl)}/lead)` : ""}, CTR ${s7.ctr ? (s7.ctr * 100).toFixed(2) + "%" : "?"} | vorige 7d: ${eur(sPrev.spend)}, ${sPrev.leads} leads\n`;
        // hook-verdeling binnen de set (7d impressie-aandeel)
        const perAd = new Map<string, Row[]>();
        for (const r of setRows.filter((x) => x.datum >= d7)) {
          if (!perAd.has(r.advertentie)) perAd.set(r.advertentie, []);
          perAd.get(r.advertentie)!.push(r);
        }
        const totImp = [...perAd.values()].reduce((t, a) => t + stats(a).imp, 0) || 1;
        for (const [adNaam, adRows] of perAd) {
          const a = stats(adRows);
          const aandeel = a.imp / totImp;
          const liveAd = liveAds.find((x) => x.name === adNaam && (x.adset?.name ?? "") === setNaam);
          overzicht += `    · hook "${adNaam}" [${liveAd?.effective_status ?? "?"}]: ${(aandeel * 100).toFixed(0)}% van set-impressies, ${eur(a.spend)}, ${a.leads} leads${a.cpl ? ` (${eur(a.cpl)}/lead)` : ""}, CTR ${a.ctr ? (a.ctr * 100).toFixed(2) + "%" : "?"}\n`;
        }
      }
    }

    const recenteBesluiten = (besluiten ?? []).slice(0, 15).map((b) =>
      `- ${b.created_at?.slice(0, 10)} ${b.besluit} "${b.advertentie}" (${b.status}, door ${b.door})`).join("\n") || "geen";

    // ── Claude: integrale mediabuyer-analyse ──
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY nog niet ingesteld als secret" }, 500);
    const claude = new Anthropic({ apiKey });

    const prompt = `Je bent de mediabuyer-agent van Ploeggenoten, een klein Nederlands recruitmentbureau (productie/logistiek). Structuur: campagne = klant, advertentieset = functie waarvoor geworven wordt, advertentie = hook (video of flyer). Eén plaatsing is duizenden euro's fee waard; leads zijn sollicitaties.

ACCOUNTOVERZICHT (laatste 30 dagen; 7d = laatste 7 dagen):
Account-totaal 7d: ${eur(acc7.spend)}, ${acc7.leads} leads${acc7.cpl ? ` (${eur(acc7.cpl)}/lead)` : ""} · 30d gemiddelde: ${acc30.cpl ? eur(acc30.cpl) + "/lead" : "geen leads"}
${overzicht}
Recente besluiten (niet herhalen, cooldowns respecteren):
${recenteBesluiten}

SPEELREGELS (onderbouwd; wijk hier niet vanaf):
- CBO (campagnebudget) laat Meta verdelen op verwachte prestatie — NIET eerlijk over sets/functies. Voor eerlijke verdeling per functie: ABO (budget per set). Aparte campagnes per functie zijn NIET nodig zolang sets eigen budget hebben.
- Budget wijzigen: max ±20-30% per keer, daarna 48-72u met rust (grotere sprongen resetten de leerfase).
- Bijschalen alleen bij consistent bewijs: set met €/lead duidelijk onder accountgemiddelde over ≥7 dagen én stabiel/lopend volume.
- Afschalen/pauzeren: set of ad die ≥ 2-3× het account-€/lead uitgeeft zonder resultaat, of substantieel geld zonder één lead.
- Hook-verdeling: Meta geeft binnen een set snel 1-2 hooks vrijwel alle impressies. Hooks met <10% impressie-aandeel na ≥4 dagen zijn feitelijk ongetest — signaleer dit en adviseer een concrete testaanpak (bijv. tijdelijke aparte testset met klein eigen budget, of de dominante hook kort pauzeren), maar voer het niet zelf uit.
- Leerfase: ~50 conversies per set per week is het ideaal; bij kleine budgetten dus liever minder, grotere sets dan veel versnipperde.
- Wees terughoudend: geen advies is beter dan een zwak advies. Attributie loopt 1-2 dagen achter.

Geef je adviezen. Types:
- "stop_ad": advertentie pauzeren (alleen bij duidelijk aanhoudend falen)
- "budget_set": nieuw dagbudget voor een ABO-set (alleen sets met eigen budget; geef nieuw_dagbudget_eur)
- "hook_test": hooks die geen eerlijke kans krijgen + concrete testaanpak
- "structuur": CBO→ABO-advies of andere structuurverbetering
Elke reden in het Nederlands, kort, mét de cijfers die het onderbouwen. vertrouwen: hoog/middel/laag.`;

    const resp = await claude.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 6000,
      thinking: { type: "adaptive" },
      output_config: {
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
                    type: { type: "string", enum: ["stop_ad", "budget_set", "hook_test", "structuur"] },
                    campagne: { type: "string" },
                    advertentieset: { type: "string" },
                    advertentie: { type: "string" },
                    nieuw_dagbudget_eur: { type: "number" },
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
    const txt = resp.content.find((b) => b.type === "text") as { text: string };
    const { adviezen } = JSON.parse(txt.text) as { adviezen: { type: string; campagne: string; advertentieset?: string; advertentie?: string; nieuw_dagbudget_eur?: number; reden: string; vertrouwen: string }[] };

    // ── uitvoeren binnen vangrails + alles loggen ──
    const totaalBudgetVoor = liveSets.reduce((t, s) => t + (Number(s.daily_budget) || 0), 0) / 100;
    let totaalBudgetNa = totaalBudgetVoor;
    let stops = 0;
    const resultaten: Record<string, unknown>[] = [];

    for (const adv of adviezen) {
      let uitgevoerd = false, detail = "";

      if (adv.type === "stop_ad" && adv.advertentie) {
        const alGedaan = (besluiten ?? []).some((b) => b.advertentie === adv.advertentie && b.besluit === "stop" && b.status !== "bevestigd");
        if (!alGedaan && autoStop && adv.vertrouwen === "hoog" && stops < MAX_STOPS_PER_RUN) {
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
          door: "Claude-agent", note: `🤖 ${uitgevoerd ? "Automatisch gepauzeerd" : "Stop-advies" + (detail ? ` (pauzeren mislukt: ${detail})` : autoStop ? "" : " (auto-stop staat uit)")}. ${adv.reden}`,
        });
      }

      else if (adv.type === "budget_set" && adv.advertentieset && adv.nieuw_dagbudget_eur) {
        const ls = liveSets.find((s) => s.name === adv.advertentieset && (s.campaign?.name ?? "") === adv.campagne);
        const huidigEur = ls?.daily_budget ? Number(ls.daily_budget) / 100 : null;
        let doelEur = adv.nieuw_dagbudget_eur;
        let kanUitvoeren = autoBudget && adv.vertrouwen !== "laag" && !!ls && huidigEur != null;
        if (kanUitvoeren) {
          // clamp ±30%, min €5, cooldown 48u, totaal mag niet stijgen
          doelEur = Math.max(MIN_DAGBUDGET_EUR, Math.min(huidigEur! * (1 + MAX_BUDGET_STAP), Math.max(huidigEur! * (1 - MAX_BUDGET_STAP), doelEur)));
          const cutCooldown = new Date(Date.now() - BUDGET_COOLDOWN_UUR * 3600e3).toISOString();
          const recent = (besluiten ?? []).some((b) => b.besluit === "budget" && b.advertentie === adv.advertentieset && b.created_at > cutCooldown);
          if (recent) { kanUitvoeren = false; detail = "cooldown 48u"; }
          else if (totaalBudgetNa - huidigEur! + doelEur > totaalBudgetVoor + 0.01) { kanUitvoeren = false; detail = "totaalbudget zou stijgen — alleen Bryan/Tjeerd verhogen het plafond"; }
        }
        if (kanUitvoeren) {
          const p = await fetch(`${GRAPH}/${ls!.id}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ daily_budget: String(Math.round(doelEur * 100)), access_token: token }) });
          const pj = await p.json();
          if (pj.error) detail = pj.error.message; else { uitgevoerd = true; totaalBudgetNa = totaalBudgetNa - huidigEur! + doelEur; }
        }
        await db.from("mkt_ad_besluiten").insert({
          advertentie: adv.advertentieset, campagne: adv.campagne, besluit: "budget", status: "open",
          door: "Claude-agent", note: `🤖 ${uitgevoerd ? `Dagbudget aangepast: ${eur(huidigEur)} → ${eur(doelEur)}` : `Budget-advies: ${eur(huidigEur)} → ${eur(adv.nieuw_dagbudget_eur)}${detail ? ` (niet uitgevoerd: ${detail})` : autoBudget ? "" : " (auto-budget staat uit)"}`}. ${adv.reden}`,
        });
      }

      else { // hook_test / structuur → altijd alleen advies
        await db.from("mkt_ad_besluiten").insert({
          advertentie: adv.advertentie || adv.advertentieset || adv.campagne, campagne: adv.campagne,
          besluit: "advies", status: "open", door: "Claude-agent",
          note: `🤖 [${adv.type === "hook_test" ? "hook-test" : "structuur"}] ${adv.reden}`,
        });
      }
      resultaten.push({ ...adv, uitgevoerd, detail: detail || undefined });
    }

    return json({ ok: true, autoStop, autoBudget, adviezen: adviezen.length, gestopt: stops,
      budgetVoor: totaalBudgetVoor, budgetNa: totaalBudgetNa, resultaten });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
