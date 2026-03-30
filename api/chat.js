import jwt from "jsonwebtoken";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GCP_PROJECT = "perfomance-490910";
const BQ_DATASET = "uandes_marketing";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 2;

let cachedToken = null;
let tokenExpiry = 0;

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  try { return JSON.parse(raw); }
  catch (e) { throw new Error("Failed to parse service account: " + e.message); }
}

async function getAccessToken(sa) {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/bigquery",
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now + 3600,
  }, sa.private_key, { algorithm: "RS256" });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!resp.ok) throw new Error("OAuth2 failed: " + await resp.text());
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function runBigQueryQuery(sql, accessToken) {
  const resp = await fetch("https://bigquery.googleapis.com/bigquery/v2/projects/" + GCP_PROJECT + "/queries", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 25000, maxResults: 100 }),
  });
  if (!resp.ok) throw new Error("BigQuery error: " + await resp.text());
  const result = await resp.json();
  if (result.errors && result.errors.length > 0) throw new Error("BQ: " + result.errors.map(function(e){return e.message}).join("; "));
  if (!result.rows || result.rows.length === 0) return { totalRows: "0", rows: [], message: "Sin resultados." };
  var cols = result.schema.fields.map(function(f){return f.name});
  var rows = result.rows.map(function(r){ var o={}; r.f.forEach(function(c,i){o[cols[i]]=c.v}); return o });
  return { totalRows: result.totalRows, columns: cols, rows: rows };
}

var SYSTEM_PROMPT = "Analista de marketing digital de UAndes Online con acceso a BigQuery. Hoy es " + new Date().toISOString().split('T')[0] + " (ano 2026).\n\nDataset: `" + GCP_PROJECT + "." + BQ_DATASET + "`\n\nTablas:\n- ads_hourly_unified: date(DATE),hour,platform('Google'|'Meta'),campaign_name,campaign_id,cost_with_iva(CLP con IVA),impressions,clicks,reach,negocio,diplomado\n- FBADS_AD: DATE,AD_ID,AD_NAME,AD_GROUP_NAME,CAMPAIGN_NAME,COST(sin IVA),CLICKS,IMPRESSIONS,REACH\n- GOOGLEADS_AD: DATE,AD_ID,COST(sin IVA),CLICKS,IMPRESSIONS,CAMPAIGN_NAME\n- GOOGLEADS_KEYWORD: DATE,KEYWORD,QUALITY_SCORE,MATCH_TYPE,COST,CLICKS,IMPRESSIONS,CAMPAIGN_NAME\n- GOOGLEADS_SEARCH_QUERY: DATE,SEARCH_TERM,KEYWORD,COST,CLICKS,CONVERSIONS,CAMPAIGN_NAME\n- stg_hubspot_contacts_attributed: create_date(TIMESTAMP),detected_platform('Meta'|'Google'|'Otro'|'LinkedIn'),conversion_mql(INT64: 1=MQL)\n- dim_diplomado_mapping: campaign_name->diplomado->negocio\n\nREGLAS CRITICAS:\n- Platform SIEMPRE con mayuscula inicial: 'Meta' y 'Google' (NUNCA 'meta' o 'google')\n- FBADS/GOOGLEADS COST sin IVA, x1.19 para CLP. ads_hourly_unified ya tiene IVA.\n- CPL=Gasto con IVA / MQLs(conversion_mql=1). NUNCA por leads totales. CPL es la metrica principal.\n- Gasto con 0 MQLs = CRITICO.\n- create_date es TIMESTAMP: filtrar con TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL N DAY), NO con DATE.\n- Califica tablas: `" + GCP_PROJECT + "." + BQ_DATASET + ".tabla`\n- Responde en espanol. Montos CLP con punto miles.\n- Usa SIEMPRE UNA UNICA query. NUNCA hagas mas de 1 query.\n\nQuery para gasto por plataforma (adaptar segun periodo):\nSELECT platform, SUM(cost_with_iva) as gasto, SUM(impressions) as impressions, SUM(clicks) as clicks FROM `perfomance-490910.uandes_marketing.ads_hourly_unified` WHERE date = DATE_SUB(CURRENT_DATE(), INTERVAL 1 DAY) GROUP BY 1\n\nQuery para CPL por diplomado (adaptar segun periodo):\nSELECT COALESCE(a.negocio,'Sin asignar') as negocio, COALESCE(a.diplomado,a.campaign_name) as diplomado, a.platform, SUM(a.cost_with_iva) as gasto, SUM(a.clicks) as clicks, (SELECT COUNT(*) FROM `perfomance-490910.uandes_marketing.stg_hubspot_contacts_attributed` h WHERE h.conversion_mql=1 AND h.detected_platform=a.platform AND h.create_date>=TIMESTAMP_SUB(CURRENT_TIMESTAMP(),INTERVAL 7 DAY)) as mqls FROM `perfomance-490910.uandes_marketing.ads_hourly_unified` a WHERE a.date>=DATE_SUB(CURRENT_DATE(),INTERVAL 7 DAY) GROUP BY 1,2,3 HAVING gasto>10000 ORDER BY gasto DESC LIMIT 30\n\nMarca CRITICO cuando gasto>0 y mqls=0.";

var TOOLS = [{
  name: "run_bigquery_query",
  description: "Ejecuta SQL en BigQuery. Tablas: `perfomance-490910.uandes_marketing.tabla`",
  input_schema: {
    type: "object",
    properties: { sql: { type: "string", description: "SQL BigQuery Standard" } },
    required: ["sql"],
  },
}];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    var messages = req.body.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: "messages required" });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "API key not configured" });

    var sa = parseServiceAccount();
    var accessToken = await getAccessToken(sa);
    var currentMessages = messages.slice();
    var rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      console.log("[R" + rounds + "] calling Claude");

      var claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2048, system: SYSTEM_PROMPT, tools: TOOLS, messages: currentMessages }),
      });

      if (!claudeResp.ok) {
        var et = await claudeResp.text();
        console.error("[Claude] " + claudeResp.status + ": " + et.substring(0,200));
        return res.status(502).json({ error: "Claude error " + claudeResp.status, detail: et.substring(0,200) });
      }

      var cd = await claudeResp.json();
      console.log("[R" + rounds + "] stop:" + cd.stop_reason);

      if (cd.stop_reason === "end_turn" || cd.stop_reason === "max_tokens") {
        var text = cd.content.filter(function(b){return b.type==="text"}).map(function(b){return b.text}).join("\n");
        return res.status(200).json({ response: text });
      }

      if (cd.stop_reason === "tool_use") {
        currentMessages.push({ role: "assistant", content: cd.content });
        var results = [];
        for (var i = 0; i < cd.content.length; i++) {
          var b = cd.content[i];
          if (b.type !== "tool_use") continue;
          var sql = b.input ? b.input.sql : null;
          if (!sql) { results.push({ type:"tool_result", tool_use_id:b.id, content:"{\"error\":\"no sql\"}", is_error:true }); continue; }
          try {
            console.log("[BQ] " + sql.substring(0,150));
            var qr = await runBigQueryQuery(sql, accessToken);
            var rs = JSON.stringify(qr);
            if (rs.length > 12000) { qr.rows = qr.rows.slice(0,30); qr.note = "Truncado a 30 filas"; rs = JSON.stringify(qr); }
            results.push({ type:"tool_result", tool_use_id:b.id, content:rs });
          } catch(e) {
            console.error("[BQ] " + e.message);
            results.push({ type:"tool_result", tool_use_id:b.id, content:JSON.stringify({error:e.message}), is_error:true });
          }
        }
        currentMessages.push({ role: "user", content: results });
        continue;
      }

      var ft = cd.content ? cd.content.filter(function(b){return b.type==="text"}).map(function(b){return b.text}).join("\n") : "";
      return res.status(200).json({ response: ft || "Sin respuesta." });
    }

    // Rounds exhausted — force Claude to answer with whatever data it has
    console.log("[FINAL] Forcing answer without tools");
    try {
      currentMessages.push({ role: "user", content: [{ type: "text", text: "Ya tienes suficientes datos. Responde ahora con lo que tienes. No hagas mas queries." }] });
      var finalResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2048, system: SYSTEM_PROMPT, messages: currentMessages }),
      });
      if (finalResp.ok) {
        var fd = await finalResp.json();
        var ft = fd.content ? fd.content.filter(function(b){return b.type==="text"}).map(function(b){return b.text}).join("\n") : "";
        if (ft) return res.status(200).json({ response: ft });
      }
    } catch(e) { console.error("[FINAL] " + e.message); }
    return res.status(200).json({ response: "No se pudo completar el analisis. Intenta con una pregunta mas especifica." });
  } catch (err) {
    console.error("[FATAL]", err);
    return res.status(500).json({ error: "Error interno", detail: err.message });
  }
}
