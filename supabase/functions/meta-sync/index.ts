// ═══ META-SYNC · Supabase Edge Function ═══
// Haalt advertentie-inzichten (laatste 30 dagen, per dag per advertentie) uit de
// officiële Meta Marketing API en schrijft ze naar mkt_meta_stats. Daarnaast per campagne
// status, budget, id en kerncijfers per periode (vandaag t/m vorige maand) naar mkt_meta_campagnes.
// Secrets (Dashboard → Edge Functions → Secrets):
//   META_ACCESS_TOKEN   — System User-token met ads_read (Business Manager)
//   META_AD_ACCOUNT_ID  — advertentieaccount-id, met of zonder 'act_'-prefix
//   CRON_SECRET         — machine-sleutel waarmee pg_cron dagelijks mag syncen
// Elke ingelogde teamgebruiker mag syncen; de token blijft server-side.
// Dagelijkse sync: pg_cron → net.http_post met header x-cron-key = CRON_SECRET.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
// Meta meldt dezelfde lead onder meerdere actie-namen ("lead" is het totaal; formulier-leads
// staan óók als "onsite_conversion.lead_grouped"). Optellen gaf precies het dubbele (vergeleken
// met Ads Manager, 26 okt 2026). Daarom: één bron per regel, in deze volgorde van voorkeur —
// gelijk aan de kolom "Resultaten · Leads (formulier)" in Ads Manager.
const LEAD_VOORKEUR = ["onsite_conversion.lead_grouped", "leadgen_grouped", "lead", "offsite_conversion.fb_pixel_lead", "onsite_web_lead"];
function leadsUit(acts?: { action_type: string; value: string }[]): number {
  for (const type of LEAD_VOORKEUR) {
    const a = (acts ?? []).find((x) => x.action_type === type);
    if (a) return Number(a.value || 0);
  }
  return 0;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    // ── toegang: ingelogd teamlid ÓF de dagelijkse cron met machine-sleutel ──
    const cronSecret = Deno.env.get("CRON_SECRET");
    const isCron = !!cronSecret && req.headers.get("x-cron-key") === cronSecret;
    if (!isCron) {
      const authClient = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_ANON_KEY")!,
        { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } },
      );
      const { data: { user } } = await authClient.auth.getUser();
      if (!user) return json({ error: "geen toegang — log in" }, 403);
    }

    const token = Deno.env.get("META_ACCESS_TOKEN");
    let account = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
    if (!token || !account) {
      return json({ error: "META_ACCESS_TOKEN / META_AD_ACCOUNT_ID nog niet ingesteld als secret (fase 2-setup)" }, 500);
    }
    if (!account.startsWith("act_")) account = "act_" + account;

    // ── debug-stand: laat zien wat de token is en mag (geen geheimen in de output) ──
    const url0 = new URL(req.url);
    if (url0.searchParams.get("debug") === "1") {
      const q = async (path: string) =>
        await (await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`)).json();
      const me = await q("me?fields=id,name");
      const perms = await q("me/permissions");
      const accts = await q("me/adaccounts?fields=id,name,account_status&limit=25");
      return json({ debug: true, gezocht_account: account, me, permissions: perms, adaccounts: accts });
    }

    // ── inzichten ophalen: per dag, per advertentie, laatste 30 dagen ──
    // LET OP: date_preset=last_30d loopt bij Meta tot en met GISTEREN — dan blijft de
    // lopende dag altijd leeg en heeft meermaals per dag kijken geen zin. Daarom een
    // expliciete time_range die vandaag wél meeneemt (cijfers van vandaag zijn deels;
    // de app labelt die dag als 'loopt nog' en de waakhond oordeelt er niet over).
    const vandaag = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Amsterdam" }); // YYYY-MM-DD
    const startD = new Date(vandaag + "T12:00:00Z");
    // standaard 30 dagen; eenmalig verder terug kan met ?dagen=90 (bijv. om oude cijfers te herstellen)
    const dagenTerug = Math.min(90, Math.max(1, Number(url0.searchParams.get("dagen")) || 30));
    startD.setDate(startD.getDate() - (dagenTerug - 1));
    const sinds = startD.toISOString().slice(0, 10);
    const range = encodeURIComponent(JSON.stringify({ since: sinds, until: vandaag }));
    // + videocijfers per advertentie (zelfde kolommen als in Ads Manager)
    const fields = "ad_id,campaign_name,adset_name,ad_name,spend,impressions,clicks,inline_link_clicks,reach,actions," +
      "video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions," +
      "video_p95_watched_actions,video_thruplay_watched_actions,video_avg_time_watched_actions";
    const somV = (a?: { value: string }[]) => (a ?? []).reduce((t, x) => t + Number(x.value || 0), 0);
    let url = `${GRAPH}/${account}/insights?level=ad&fields=${fields}` +
      `&time_increment=1&time_range=${range}&limit=500&access_token=${encodeURIComponent(token)}`;
    // Meerdere ads kunnen dezelfde naam hebben → aggregeer per (datum, campagne, set, advertentienaam),
    // zodat de unieke sleutel op die vier kolommen nooit botst. ad_id gaat mee als gegeven.
    const agg = new Map<string, Record<string, unknown>>();
    for (let page = 0; page < 40 && url; page++) {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) return json({ error: "Meta API: " + (data.error.message ?? JSON.stringify(data.error)) }, 502);
      for (const r of data.data ?? []) {
        const leads = leadsUit(r.actions);
        const key = `${r.date_start}|${r.campaign_name ?? ""}|${r.adset_name ?? ""}|${r.ad_name ?? ""}`;
        const cur = agg.get(key) ?? {
          datum: r.date_start, ad_id: r.ad_id ?? null, campagne: r.campaign_name ?? "", advertentieset: r.adset_name ?? "", advertentie: r.ad_name ?? "",
          uitgegeven: 0, impressies: 0, kliks: 0, link_kliks: 0, leads: 0, bereik: 0,
          video_3s: 0, video_p25: 0, video_p50: 0, video_p75: 0, video_p95: 0, thruplays: 0, video_plays: 0, video_tijd_sec: 0,
          synced_at: new Date().toISOString(),
        };
        // 3-seconden-weergaven staan bij Meta als actie "video_view"; kijktijd = gemiddelde × aantal starts
        const plays = somV(r.video_play_actions);
        cur.video_3s = (cur.video_3s as number) + Number((r.actions ?? []).find((x: { action_type: string }) => x.action_type === "video_view")?.value || 0);
        cur.video_p25 = (cur.video_p25 as number) + somV(r.video_p25_watched_actions);
        cur.video_p50 = (cur.video_p50 as number) + somV(r.video_p50_watched_actions);
        cur.video_p75 = (cur.video_p75 as number) + somV(r.video_p75_watched_actions);
        cur.video_p95 = (cur.video_p95 as number) + somV(r.video_p95_watched_actions);
        cur.thruplays = (cur.thruplays as number) + somV(r.video_thruplay_watched_actions);
        cur.video_plays = (cur.video_plays as number) + plays;
        cur.video_tijd_sec = (cur.video_tijd_sec as number) + somV(r.video_avg_time_watched_actions) * plays;
        cur.uitgegeven = (cur.uitgegeven as number) + Number(r.spend || 0);
        cur.impressies = (cur.impressies as number) + Number(r.impressions || 0);
        cur.kliks = (cur.kliks as number) + Number(r.clicks || 0);
        cur.link_kliks = (cur.link_kliks as number) + Number(r.inline_link_clicks || 0); // 2·1·5 rekent met link-klikken
        cur.leads = (cur.leads as number) + leads;
        cur.bereik = (cur.bereik as number) + Number(r.reach || 0);
        agg.set(key, cur);
      }
      url = data.paging?.next ?? "";
    }
    const rows = [...agg.values()];

    // ── wegschrijven met service-role (app leest alleen) ──
    const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    if (rows.length) {
      // Eerst het venster schoonvegen, dan vers schrijven (fix van 3 sep 2026). Een upsert op
      // de naamkolommen laat bij elke hernoeming van campagne, set of advertentie de oude rij
      // náást de nieuwe staan — augustus telde daardoor €1.6k te veel. Delete + insert binnen
      // het venster neemt altijd de huidige namen uit Meta over. Rijen vóór het venster blijven.
      const { error: wisFout } = await db.from("mkt_meta_stats")
        .delete().gte("datum", sinds).lte("datum", vandaag);
      if (wisFout) return json({ error: "schoonvegen mislukt: " + wisFout.message }, 500);
      let { error } = await db.from("mkt_meta_stats").insert(rows);
      if (error && /video|thruplay/i.test(error.message)) {
        // videokolommen bestaan nog niet (migratie-video.sql nog niet gedraaid) → zonder video opslaan
        const kaal = rows.map(({ video_3s, video_p25, video_p50, video_p75, video_p95, thruplays, video_plays, video_tijd_sec, ...r }) => r);
        ({ error } = await db.from("mkt_meta_stats").insert(kaal));
      }
      if (error) return json({ error: "opslaan mislukt: " + error.message }, 500);
    }

    // ── campagne-overzicht (status, budget, id + kerncijfers vandaag/7d/30d) → mkt_meta_campagnes ──
    // Best-effort: mislukt dit (bijv. tabel nog niet aangemaakt), dan loopt de rest gewoon door.
    let campagnes = 0;
    try {
      const qa = async (path: string) =>
        await (await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`)).json();
      const cR = await qa(`${account}/campaigns?fields=id,name,effective_status,status,daily_budget,lifetime_budget,objective&limit=300`);
      const sR = await qa(`${account}/adsets?fields=campaign_id,daily_budget,lifetime_budget,effective_status&limit=500`);
      const sets = (sR.data ?? []) as { campaign_id: string; daily_budget?: string; lifetime_budget?: string; effective_status: string }[];
      const perPeriode: Record<string, Record<string, unknown>> = {};
      // alle snelle keuzes van het bord kant-en-klaar uit Meta (dan klopt ook frequentie/bereik)
      for (const [label, preset] of [["vandaag", "today"], ["gisteren", "yesterday"], ["d7", "last_7d"], ["d14", "last_14d"],
                                     ["d30", "last_30d"], ["maand", "this_month"], ["vorigemaand", "last_month"]]) {
        const iR = await qa(`${account}/insights?level=campaign&date_preset=${preset}&limit=300` +
          `&fields=campaign_id,spend,impressions,reach,frequency,inline_link_clicks,cpm,actions`);
        for (const r of iR.data ?? []) {
          const spend = Number(r.spend || 0), imp = Number(r.impressions || 0), lk = Number(r.inline_link_clicks || 0), leads = leadsUit(r.actions);
          (perPeriode[r.campaign_id] ??= {})[label] = {
            besteed: spend, weergaven: imp, bereik: Number(r.reach || 0), frequentie: Number(r.frequency || 0),
            link_kliks: lk, resultaten: leads, cpm: Number(r.cpm || 0),
            ctr: imp ? lk / imp : null, cpc: lk ? spend / lk : null, cpl: leads ? spend / leads : null,
          };
        }
      }
      const rijen = (cR.data ?? []).map((c: { id: string; name: string; effective_status: string; status: string; daily_budget?: string; lifetime_budget?: string; objective?: string }) => {
        const cbo = !!(c.daily_budget || c.lifetime_budget);
        const setBudget = sets.filter((x) => x.campaign_id === c.id && x.effective_status === "ACTIVE")
          .reduce((t, x) => t + Number(x.daily_budget || 0), 0) / 100;
        return {
          id: c.id, naam: c.name, status: c.effective_status, aan: c.status === "ACTIVE",
          budget_type: cbo ? "campagne" : "sets",
          budget_dag: cbo ? (c.daily_budget ? Number(c.daily_budget) / 100 : null) : (setBudget || null),
          budget_looptijd: c.lifetime_budget ? Number(c.lifetime_budget) / 100 : null,
          doel: c.objective || "", cijfers: perPeriode[c.id] ?? {}, synced_at: new Date().toISOString(),
        };
      });
      if (rijen.length) {
        const { error: ce } = await db.from("mkt_meta_campagnes").upsert(rijen, { onConflict: "id" });
        if (!ce) campagnes = rijen.length;
      }
    } catch (_e) { /* campagne-overzicht is best-effort */ }

    // ── organisch: Facebook-pagina-posts → resultaten van bord-posts ──
    // (vergt pages_show_list + pages_read_engagement + pagina toegewezen aan de
    //  systeemgebruiker; faalt stil zodat de advertentie-sync nooit meelijdt)
    let organisch = 0;
    try {
      const paginas = await (await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token&access_token=${encodeURIComponent(token)}`)).json();
      const sinds = new Date(); sinds.setDate(sinds.getDate() - 30);
      const { data: bordPosts } = await db.from("mkt_posts").select("*")
        .in("fase", ["Gepubliceerd", "Learnings"]).eq("kanaal", "Facebook")
        .gte("publicatie_datum", sinds.toISOString().slice(0, 10));
      if (bordPosts?.length && paginas.data?.length) {
        for (const pagina of paginas.data) {
          const fb = await (await fetch(`${GRAPH}/${pagina.id}/posts?fields=id,created_time,permalink_url,reactions.summary(true),comments.summary(true),insights.metric(post_impressions_unique)&since=${sinds.toISOString().slice(0, 10)}&limit=100&access_token=${encodeURIComponent(pagina.access_token)}`)).json();
          for (const fp of fb.data ?? []) {
            const fpDatum = (fp.created_time || "").slice(0, 10);
            const postId = (fp.id || "").split("_")[1] || fp.id;
            // match: (1) bord-link bevat het post-id, anders (2) enige kandidaat op dezelfde dag
            let doel = bordPosts.find((b: { link?: string }) => b.link && postId && b.link.includes(postId));
            if (!doel) {
              const zelfdeDag = bordPosts.filter((b: { publicatie_datum?: string; link?: string }) => b.publicatie_datum === fpDatum && !b.link);
              if (zelfdeDag.length === 1) doel = zelfdeDag[0];
            }
            if (!doel) continue;
            const bereik = fp.insights?.data?.find((m: { name: string }) => m.name === "post_impressions_unique")?.values?.[0]?.value ?? 0;
            const resultaat = { ...(doel.resultaat || {}),
              bereik: Number(bereik) || doel.resultaat?.bereik || 0,
              likes: fp.reactions?.summary?.total_count ?? doel.resultaat?.likes ?? 0,
              reacties: fp.comments?.summary?.total_count ?? doel.resultaat?.reacties ?? 0,
            };
            const upd: Record<string, unknown> = { resultaat };
            if (!doel.link && fp.permalink_url) upd.link = fp.permalink_url;
            const { error: ue } = await db.from("mkt_posts").update(upd).eq("id", doel.id);
            if (!ue) { organisch++; doel.link = doel.link || fp.permalink_url; doel.resultaat = resultaat; }
          }
        }
      }
    } catch (_e) { /* organisch is best-effort */ }

    return json({ ok: true, regels: rows.length, campagnes, organisch, account });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
