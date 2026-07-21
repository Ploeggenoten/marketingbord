// ═══ AD-GUARD · Claude-advies-agent met auto-stop ═══
// Draait na elke meta-sync (cron) of handmatig vanuit de app.
// 1. Leest mkt_meta_stats en selecteert stop-kandidaten met STRIKTE regels
// 2. Claude (Opus 4.8) geeft per kandidaat een tweede oordeel met reden
// 3. Bij "pauzeren" + voldoende vertrouwen: pauzeert de advertentie via de
//    Meta API (vergt ads_management op de token) en logt het besluit in
//    mkt_ad_besluiten (door: 'Claude-agent') — de app-waakhond bewaakt daarna
//    of de uitgaven echt stoppen.
// Vangrails: alleen PAUZEREN (nooit budget/verwijderen), max 2 stops per run,
// staat standaard UIT (schakelaar in de app = config-rij __auto_stop__),
// respecteert 'negeer'-besluiten van Bryan 7 dagen.
// Secrets: META_ACCESS_TOKEN (met ads_management voor echt pauzeren),
// META_AD_ACCOUNT_ID, ANTHROPIC_API_KEY, CRON_SECRET.
import { createClient } from "jsr:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_STOPS_PER_RUN = 2;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Row = { datum: string; campagne: string; advertentie: string; uitgegeven: number; impressies: number; kliks: number; leads: number; bereik: number };

function stats(rows: Row[]) {
  const s = { spend: 0, imp: 0, kliks: 0, leads: 0 };
  for (const r of rows) { s.spend += +r.uitgegeven || 0; s.imp += +r.impressies || 0; s.kliks += +r.kliks || 0; s.leads += +r.leads || 0; }
  return { ...s, cpc: s.kliks ? s.spend / s.kliks : null, ctr: s.imp ? s.kliks / s.imp : null, cpl: s.leads ? s.spend / s.leads : null };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // ── toegang: cron met machine-sleutel óf ingelogd teamlid ──
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

    // ── staat de agent aan? (laatste __auto_stop__-config-rij; standaard UIT) ──
    const { data: cfgRows } = await db.from("mkt_ad_besluiten")
      .select("besluit,created_at").eq("advertentie", "__auto_stop__")
      .order("created_at", { ascending: false }).limit(1);
    const actief = cfgRows?.[0]?.besluit === "aan";
    const url0 = new URL(req.url);
    const force = url0.searchParams.get("force") === "1"; // handmatige run vanuit de app mag altijd adviseren
    if (!actief && !force) return json({ ok: true, actief: false, melding: "Auto-stop staat uit — zet hem aan in de app (Prestatie → waakhond)." });

    // ── data laden ──
    const cut30 = daysAgo(30);
    const { data: metaRows } = await db.from("mkt_meta_stats").select("*").gte("datum", cut30);
    const { data: besluiten } = await db.from("mkt_ad_besluiten").select("*").neq("advertentie", "__auto_stop__");
    if (!metaRows?.length) return json({ ok: true, melding: "geen advertentiedata" });

    const perAd = new Map<string, Row[]>();
    for (const r of metaRows as Row[]) {
      const k = `${r.campagne}|${r.advertentie}`;
      if (!perAd.has(k)) perAd.set(k, []);
      perAd.get(k)!.push(r);
    }
    const acc30 = stats(metaRows as Row[]);
    const d7 = daysAgo(7), d14 = daysAgo(14), d2 = daysAgo(2);

    // ── strikte voorselectie (strenger dan de app-adviezen) ──
    const kandidaten: { campagne: string; advertentie: string; reden: string; s7: ReturnType<typeof stats>; sPrev: ReturnType<typeof stats>; s30: ReturnType<typeof stats> }[] = [];
    for (const [k, rows] of perAd) {
      const [campagne, advertentie] = k.split("|");
      const s2 = stats(rows.filter((r) => r.datum >= d2));
      if (s2.spend < 0.5) continue; // draait niet (meer) — niets te stoppen
      const open = (besluiten ?? []).find((b) => b.advertentie === advertentie && b.campagne === campagne &&
        (b.besluit === "stop" && b.status !== "bevestigd" ||
         b.besluit === "negeer" && (Date.now() - new Date(b.created_at).getTime()) / 864e5 < 7));
      if (open) continue;
      const s7 = stats(rows.filter((r) => r.datum >= d7));
      const sPrev = stats(rows.filter((r) => r.datum >= d14 && r.datum < d7));
      const s30 = stats(rows);
      if (s7.spend >= 25 && s7.leads === 0 && s30.leads === 0) {
        kandidaten.push({ campagne, advertentie, reden: `€${s7.spend.toFixed(0)} in 7 dgn, nul leads (ook 0 in 30 dgn)`, s7, sPrev, s30 });
      } else if (s7.cpl && acc30.cpl && s7.cpl > 3 * acc30.cpl && s7.spend >= 40) {
        kandidaten.push({ campagne, advertentie, reden: `€${s7.cpl.toFixed(0)}/lead vs €${acc30.cpl.toFixed(0)} accountgemiddelde (${(s7.cpl / acc30.cpl).toFixed(1)}×)`, s7, sPrev, s30 });
      }
    }
    if (!kandidaten.length) return json({ ok: true, actief, kandidaten: 0, melding: "geen stop-kandidaten — alles binnen de marges" });

    // ── Claude: tweede oordeel per kandidaat ──
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return json({ error: "ANTHROPIC_API_KEY nog niet ingesteld als secret" }, 500);
    const claude = new Anthropic({ apiKey });

    const token = Deno.env.get("META_ACCESS_TOKEN")!;
    let account = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
    if (!account.startsWith("act_")) account = "act_" + account;

    const resultaten: Record<string, unknown>[] = [];
    let stops = 0;
    for (const kd of kandidaten.slice(0, 5)) { // beoordeel max 5 per run
      const f = (s: ReturnType<typeof stats>) =>
        `€${s.spend.toFixed(2)} uitgegeven, ${s.imp} impressies, ${s.kliks} kliks (CTR ${s.ctr ? (s.ctr * 100).toFixed(2) : "?"}%, CPC ${s.cpc ? "€" + s.cpc.toFixed(2) : "?"}), ${s.leads} leads${s.cpl ? ` (€${s.cpl.toFixed(2)}/lead)` : ""}`;
      const prompt = `Je bent de advertentie-waakhond van Ploeggenoten, een klein Nederlands recruitmentbureau voor productie/logistiek. Je beoordeelt of één Meta-advertentie GEPAUZEERD moet worden.

Advertentie: "${kd.advertentie}" in campagne "${kd.campagne}"
Signaal uit de voorselectie: ${kd.reden}

Cijfers:
- Laatste 7 dagen: ${f(kd.s7)}
- 7 dagen daarvóór: ${f(kd.sPrev)}
- Laatste 30 dagen: ${f(kd.s30)}
- Accountgemiddelde 30 dagen: ${f(acc30)}

Weeg mee:
- Meta schrijft leads soms 1-2 dagen later toe; een advertentie die pas net draait of net een lead-dip heeft verdient het voordeel van de twijfel.
- Pauzeren is omkeerbaar maar verstoort de leerfase van de campagne; doe het alleen bij duidelijk en aanhoudend bewijs van verspilling.
- Recruitment-context: één plaatsing is duizenden euro's waard, dus een matige €/lead is niet per se slecht — maar geld zonder énige lead is dat wel.

Beslis: pauzeren of laten lopen?`;
      const resp = await claude.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        output_config: {
          format: {
            type: "json_schema",
            schema: {
              type: "object",
              properties: {
                pauzeren: { type: "boolean" },
                vertrouwen: { type: "string", enum: ["hoog", "middel", "laag"] },
                reden: { type: "string", description: "Korte Nederlandse uitleg voor Bryan (1-2 zinnen, met cijfers)" },
              },
              required: ["pauzeren", "vertrouwen", "reden"],
              additionalProperties: false,
            },
          },
        },
        messages: [{ role: "user", content: prompt }],
      });
      if (resp.stop_reason === "refusal") { resultaten.push({ ad: kd.advertentie, oordeel: "geen (refusal)" }); continue; }
      const txt = resp.content.find((b) => b.type === "text");
      const oordeel = JSON.parse((txt as { text: string }).text) as { pauzeren: boolean; vertrouwen: string; reden: string };

      if (!oordeel.pauzeren || oordeel.vertrouwen === "laag" || stops >= MAX_STOPS_PER_RUN) {
        resultaten.push({ ad: kd.advertentie, oordeel });
        continue;
      }

      // ── pauzeren via Meta (alleen status=PAUSED, niets anders) ──
      let gepauzeerd = false, pauzeFout = "";
      try {
        const adsResp = await fetch(`${GRAPH}/${account}/ads?fields=id,name,campaign{name},effective_status&limit=500&access_token=${encodeURIComponent(token)}`);
        const ads = await adsResp.json();
        const doelen = (ads.data ?? []).filter((a: { name: string; campaign?: { name: string }; effective_status: string }) =>
          a.name === kd.advertentie && (a.campaign?.name ?? "") === kd.campagne && a.effective_status === "ACTIVE");
        if (!doelen.length) pauzeFout = "advertentie niet (actief) gevonden via API";
        for (const ad of doelen) {
          const p = await fetch(`${GRAPH}/${ad.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ status: "PAUSED", access_token: token }),
          });
          const pj = await p.json();
          if (pj.error) pauzeFout = pj.error.message ?? JSON.stringify(pj.error);
          else gepauzeerd = true;
        }
      } catch (e) { pauzeFout = String(e); }

      const note = gepauzeerd
        ? `🤖 Automatisch gepauzeerd. ${oordeel.reden}`
        : `🤖 Stop-advies (pauzeren via API mislukt: ${pauzeFout || "onbekend"} — zet handmatig uit). ${oordeel.reden}`;
      await db.from("mkt_ad_besluiten").insert({
        advertentie: kd.advertentie, campagne: kd.campagne, besluit: "stop",
        status: "open", door: "Claude-agent", note,
      });
      stops++;
      resultaten.push({ ad: kd.advertentie, oordeel, gepauzeerd, pauzeFout: pauzeFout || undefined });
    }

    return json({ ok: true, actief, kandidaten: kandidaten.length, beoordeeld: resultaten.length, gestopt: stops, resultaten });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
