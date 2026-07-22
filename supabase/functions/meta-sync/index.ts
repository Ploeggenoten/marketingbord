// ═══ META-SYNC · Supabase Edge Function ═══
// Haalt advertentie-inzichten (laatste 30 dagen, per dag per advertentie) uit de
// officiële Meta Marketing API en schrijft ze naar mkt_meta_stats.
// Secrets (Dashboard → Edge Functions → Secrets):
//   META_ACCESS_TOKEN   — System User-token met ads_read (Business Manager)
//   META_AD_ACCOUNT_ID  — advertentieaccount-id, met of zonder 'act_'-prefix
//   CRON_SECRET         — machine-sleutel waarmee pg_cron dagelijks mag syncen
// Elke ingelogde teamgebruiker mag syncen; de token blijft server-side.
// Dagelijkse sync: pg_cron → net.http_post met header x-cron-key = CRON_SECRET.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
const LEAD_TYPES = new Set([
  "lead", "leadgen_grouped", "onsite_conversion.lead_grouped",
  "offsite_conversion.fb_pixel_lead", "onsite_web_lead",
]);

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
    const fields = "campaign_name,adset_name,ad_name,spend,impressions,clicks,reach,actions";
    let url = `${GRAPH}/${account}/insights?level=ad&fields=${fields}` +
      `&time_increment=1&date_preset=last_30d&limit=500&access_token=${encodeURIComponent(token)}`;
    // Meerdere ads kunnen dezelfde naam hebben → aggregeer per (datum, campagne, advertentienaam),
    // anders botst de upsert ("cannot affect row a second time").
    const agg = new Map<string, Record<string, unknown>>();
    for (let page = 0; page < 10 && url; page++) {
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) return json({ error: "Meta API: " + (data.error.message ?? JSON.stringify(data.error)) }, 502);
      for (const r of data.data ?? []) {
        const leads = (r.actions ?? [])
          .filter((a: { action_type: string }) => LEAD_TYPES.has(a.action_type))
          .reduce((s: number, a: { value: string }) => s + Number(a.value || 0), 0);
        const key = `${r.date_start}|${r.campaign_name ?? ""}|${r.adset_name ?? ""}|${r.ad_name ?? ""}`;
        const cur = agg.get(key) ?? {
          datum: r.date_start, campagne: r.campaign_name ?? "", advertentieset: r.adset_name ?? "", advertentie: r.ad_name ?? "",
          uitgegeven: 0, impressies: 0, kliks: 0, leads: 0, bereik: 0,
          synced_at: new Date().toISOString(),
        };
        cur.uitgegeven = (cur.uitgegeven as number) + Number(r.spend || 0);
        cur.impressies = (cur.impressies as number) + Number(r.impressions || 0);
        cur.kliks = (cur.kliks as number) + Number(r.clicks || 0);
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
      const { error } = await db.from("mkt_meta_stats")
        .upsert(rows, { onConflict: "datum,campagne,advertentieset,advertentie" });
      if (error) return json({ error: "opslaan mislukt: " + error.message }, 500);
    }

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

    return json({ ok: true, regels: rows.length, organisch, account });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
