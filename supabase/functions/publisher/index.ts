// ═══ PUBLISHER · publiceert ingeplande posts echt op Facebook & Instagram ═══
// Draait elke 10 min (cron). Pakt bord-posts met: fase 'Ingepland' +
// 🚀 auto_publish + publicatiedatum/-tijd bereikt, en publiceert ze via de
// officiële Graph API. Daarna: fase → Gepubliceerd, link = permalink, en de
// organische import (meta-sync) haalt vervolgens vanzelf de resultaten binnen.
//
// Vereist op de token: pages_manage_posts (+ instagram_basic +
// instagram_content_publish voor Instagram) en de pagina + het IG-account als
// toegewezen bedrijfsmiddelen van de systeemgebruiker.
//
// Veiligheid: max 3 publicaties per run; bij een fout wordt auto_publish
// uitgezet en de fout in publiceer_log gezet zodat er nooit een publiceer-loop
// ontstaat — Bryan ziet de fout in de app en kan opnieuw aanzetten.
import { createClient } from "jsr:@supabase/supabase-js@2";

const GRAPH = "https://graph.facebook.com/v21.0";
const MAX_PER_RUN = 3;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

const isVideo = (url: string) => /\.(mp4|mov|m4v|webm)(\?|$)/i.test(url);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
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
    const token = Deno.env.get("META_ACCESS_TOKEN");
    if (!token) return json({ error: "META_ACCESS_TOKEN ontbreekt" }, 500);

    // ── kandidaten: 🚀 aan, Ingepland, datum+tijd bereikt (NL-tijd ≈ UTC+2 zomertijd) ──
    const nu = new Date();
    const nlNu = new Date(nu.getTime() + 2 * 3600e3); // Europe/Amsterdam zomertijd
    const vandaag = nlNu.toISOString().slice(0, 10);
    const tijdNu = nlNu.toISOString().slice(11, 16);
    const { data: kandidaten } = await db.from("mkt_posts").select("*")
      .eq("fase", "Ingepland").eq("auto_publish", true).lte("publicatie_datum", vandaag);
    const rijp = (kandidaten ?? []).filter((p) =>
      p.publicatie_datum < vandaag || !p.publicatie_tijd || p.publicatie_tijd.slice(0, 5) <= tijdNu);
    if (!rijp.length) return json({ ok: true, gepubliceerd: 0 });

    // ── pagina + IG-account ophalen ──
    const paginas = await (await fetch(`${GRAPH}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(token)}`)).json();
    const pagina = paginas.data?.[0];
    if (!pagina) return json({ error: "geen Facebook-pagina toegewezen aan de systeemgebruiker (of pages_manage_posts ontbreekt)" }, 500);
    const pt = pagina.access_token;
    const igId = pagina.instagram_business_account?.id;

    const resultaten: Record<string, unknown>[] = [];
    let gepubliceerd = 0;
    for (const p of rijp.slice(0, MAX_PER_RUN)) {
      const caption = (p.script || p.titel || "").trim();
      let fout = "", link = "";
      try {
        if (p.kanaal === "Facebook") {
          let r;
          if (p.media_url && isVideo(p.media_url)) {
            r = await (await fetch(`${GRAPH}/${pagina.id}/videos`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ file_url: p.media_url, description: caption, access_token: pt }) })).json();
            if (!r.error) link = `https://www.facebook.com/${pagina.id}/videos/${r.id}`;
          } else if (p.media_url) {
            r = await (await fetch(`${GRAPH}/${pagina.id}/photos`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ url: p.media_url, caption, access_token: pt }) })).json();
            if (!r.error && r.post_id) link = `https://www.facebook.com/${r.post_id}`;
          } else {
            r = await (await fetch(`${GRAPH}/${pagina.id}/feed`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ message: caption, access_token: pt }) })).json();
            if (!r.error) link = `https://www.facebook.com/${r.id}`;
          }
          if (r.error) fout = r.error.message;
        } else if (p.kanaal === "Instagram") {
          if (!igId) fout = "geen Instagram-zakelijk account gekoppeld aan de pagina";
          else if (!p.media_url) fout = "Instagram vereist een foto of video";
          else {
            const body: Record<string, string> = { caption, access_token: pt };
            if (isVideo(p.media_url)) { body.media_type = "REELS"; body.video_url = p.media_url; }
            else body.image_url = p.media_url;
            const c = await (await fetch(`${GRAPH}/${igId}/media`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) })).json();
            if (c.error) fout = c.error.message;
            else {
              // video's verwerken duurt even — poll tot FINISHED (max ~100s)
              for (let i = 0; i < 20; i++) {
                const st = await (await fetch(`${GRAPH}/${c.id}?fields=status_code&access_token=${encodeURIComponent(pt)}`)).json();
                if (st.status_code === "FINISHED") break;
                if (st.status_code === "ERROR") { fout = "Instagram kon de media niet verwerken"; break; }
                await sleep(5000);
              }
              if (!fout) {
                const pub = await (await fetch(`${GRAPH}/${igId}/media_publish`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ creation_id: c.id, access_token: pt }) })).json();
                if (pub.error) fout = pub.error.message;
                else {
                  const perm = await (await fetch(`${GRAPH}/${pub.id}?fields=permalink&access_token=${encodeURIComponent(pt)}`)).json();
                  link = perm.permalink || "";
                }
              }
            }
          }
        } else {
          fout = `automatisch publiceren op ${p.kanaal} is nog niet beschikbaar (alleen Facebook/Instagram)`;
        }
      } catch (e) { fout = String(e); }

      if (fout) {
        await db.from("mkt_posts").update({ auto_publish: false, publiceer_log: `⚠ ${nlNu.toISOString().slice(0, 16).replace("T", " ")}: ${fout}` }).eq("id", p.id);
      } else {
        await db.from("mkt_posts").update({
          fase: "Gepubliceerd", auto_publish: false, link: link || p.link,
          publiceer_log: `✅ ${nlNu.toISOString().slice(0, 16).replace("T", " ")} automatisch gepubliceerd op ${p.kanaal}`,
        }).eq("id", p.id);
        gepubliceerd++;
      }
      resultaten.push({ post: p.titel, kanaal: p.kanaal, ok: !fout, fout: fout || undefined, link: link || undefined });
    }
    return json({ ok: true, gepubliceerd, resultaten });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
