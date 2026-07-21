// ═══ META-DEBUG · tijdelijke diagnosefunctie ═══
// Vraagt Meta: wie is deze token, welke permissies, welke ad-accounts zichtbaar?
// Geen geheimen in de output. Verwijderen zodra de sync werkt.
const GRAPH = "https://graph.facebook.com/v21.0";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || req.headers.get("x-cron-key") !== cronSecret) return json({ error: "geen toegang" }, 403);
  const token = Deno.env.get("META_ACCESS_TOKEN");
  let account = Deno.env.get("META_AD_ACCOUNT_ID") ?? "";
  if (!token) return json({ error: "META_ACCESS_TOKEN ontbreekt" }, 500);
  if (!account.startsWith("act_")) account = "act_" + account;
  const q = async (path: string) =>
    await (await fetch(`${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`)).json();
  return json({
    gezocht_account: account,
    me: await q("me?fields=id,name"),
    permissions: await q("me/permissions"),
    adaccounts: await q("me/adaccounts?fields=id,name,account_status&limit=25"),
    direct_insight_test: await q(`${account}/insights?level=account&fields=spend&date_preset=last_7d`),
  });
});
