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

var SYSTEM_PROMPT = "Analista de marketing digital de UAndes Online con acceso a BigQuery. Hoy es " + new Date().toISOString().split('T')[0] + " (2026).\n\nDataset: `" + GCP_PROJECT + "." + BQ_DATASET + "`\n\nTABLAS:\n- rpt_campaign_performance_daily: date,platform('Meta'|'Google'),campaign_name,diplomado,negocio,spend_with_iva,impressions,clicks,leads,mqls,cpl_with_iva,cpl_status('critical'|'alert'|'well'). 1864 filas.\n- rpt_daily_totals: resumen por dia. 28 filas.\n- ads_hourly_unified: gasto por hora x campana.\n- GOOGLEADS_KEYWORD / GOOGLEADS_SEARCH_QUERY: keywords y search terms.\n\nREGLAS:\n- CPL=spend_with_iva/mqls. Metrica principal, NO CPC.\n- Gasto sin MQL=CRITICO.\n- Montos CLP con punto miles, sin decimales. Espanol.\n- UNA UNICA query por pregunta.\n- MUCHAS campanas tienen negocio/diplomado NULL. Cuando filtres por negocio, usa SIEMPRE: WHERE (negocio LIKE '%termino%' OR campaign_name LIKE '%termino%' OR diplomado LIKE '%termino%') para capturar campanas sin clasificar.\n\nNEGOCIOS en BigQuery (valores EXACTOS del campo negocio):\n- 'Medicina Nuevos' y 'Medicina Antiguos' — Si el cliente dice 'Medicina' o 'Salud', busca AMBOS mas campaign_name LIKE '%Salud%' o '%MED%'\n- 'Enfermeria' — Si dice 'enfermeria', busca negocio='Enfermeria' o campaign_name LIKE '%ENF%'\n- 'Derecho' — Incluye Derecho Corporativo, Penal, Urbanistico, Medio Ambiente\n- 'Educacion' — Comprension Lectora, Necesidades Educativas, Salud Mental Escolar\n- 'ICOM' — Negocios: Gestion Personas, Logistica, Big Data, Felicidad Organizacional, etc.\n- 'ICF' — Derecho de la Ninez y Adolescencia\n- 'ADS Medicina/Gestion ADS' — Gestion de Organizaciones de Salud\n- 'ADS Educacion' — Direccion y Gestion Escolar\n- 'CET/Gestion Inmobiliaria' — Gestion Inmobiliaria\n- 'UDEP (Peru)' — Programas PDE de Peru\n- 'Magister' — Magister en Direccion de Personas\n- 'Odontologia' — Gestion Organizacional en Odontologia\n- NULL (sin clasificar) — 468 campanas! Siempre incluir en busquedas amplias\n\nIMPORTANTE: Cuando el cliente pregunte por un area (ej 'Medicina'), NO filtres solo por negocio exacto. Usa: WHERE negocio IN ('Medicina Nuevos','Medicina Antiguos','ADS Medicina/Gestion ADS') OR campaign_name LIKE '%Salud%' OR campaign_name LIKE '%MED%'\n\nQUERY MAESTRA para analisis de campanas (criticas, rendimiento, CPL):\nWITH ventanas AS (SELECT campaign_name,negocio,diplomado,platform, SUM(CASE WHEN date=DATE_SUB(CURRENT_DATE(),INTERVAL 1 DAY) THEN spend_with_iva ELSE 0 END) as gasto_ayer, SUM(CASE WHEN date=DATE_SUB(CURRENT_DATE(),INTERVAL 1 DAY) THEN mqls ELSE 0 END) as mql_ayer, SUM(CASE WHEN date>=DATE_SUB(CURRENT_DATE(),INTERVAL 3 DAY) THEN spend_with_iva ELSE 0 END) as gasto_3d, SUM(CASE WHEN date>=DATE_SUB(CURRENT_DATE(),INTERVAL 3 DAY) THEN mqls ELSE 0 END) as mql_3d, SUM(CASE WHEN date>=DATE_TRUNC(CURRENT_DATE(),WEEK(MONDAY)) THEN spend_with_iva ELSE 0 END) as gasto_sem, SUM(CASE WHEN date>=DATE_TRUNC(CURRENT_DATE(),WEEK(MONDAY)) THEN mqls ELSE 0 END) as mql_sem, SUM(CASE WHEN date>=DATE_SUB(CURRENT_DATE(),INTERVAL 7 DAY) THEN spend_with_iva ELSE 0 END) as gasto_7d, SUM(CASE WHEN date>=DATE_SUB(CURRENT_DATE(),INTERVAL 7 DAY) THEN mqls ELSE 0 END) as mql_7d, SUM(CASE WHEN date>=DATE_SUB(CURRENT_DATE(),INTERVAL 14 DAY) AND date<DATE_SUB(CURRENT_DATE(),INTERVAL 7 DAY) THEN spend_with_iva ELSE 0 END) as gasto_prev7d, SUM(CASE WHEN date>=DATE_SUB(CURRENT_DATE(),INTERVAL 14 DAY) AND date<DATE_SUB(CURRENT_DATE(),INTERVAL 7 DAY) THEN mqls ELSE 0 END) as mql_prev7d FROM `" + GCP_PROJECT + "." + BQ_DATASET + ".rpt_campaign_performance_daily` WHERE date>=DATE_SUB(CURRENT_DATE(),INTERVAL 14 DAY) GROUP BY 1,2,3,4 HAVING gasto_7d>10000) SELECT campaign_name,negocio,diplomado,platform, CASE WHEN mql_7d=0 AND gasto_7d>10000 THEN 'CRITICO' WHEN mql_7d>0 AND mql_prev7d>0 AND (gasto_7d/mql_7d)>(gasto_prev7d/mql_prev7d)*2 THEN 'CRITICO' WHEN mql_7d>0 AND mql_prev7d>0 AND (gasto_7d/mql_7d)>(gasto_prev7d/mql_prev7d)*1.5 THEN 'ALERTA' WHEN mql_7d>0 AND mql_prev7d>0 AND (gasto_7d/mql_7d)<(gasto_prev7d/mql_prev7d)*0.8 THEN 'BIEN' WHEN mql_7d>0 THEN 'ESTABLE' ELSE 'CRITICO' END as estado, CASE WHEN mql_7d=0 THEN 'SIN_MQL' WHEN mql_prev7d=0 THEN 'SIN_REF' WHEN (gasto_7d/mql_7d)>(gasto_prev7d/mql_prev7d)*1.2 THEN 'EMPEORANDO' WHEN (gasto_7d/mql_7d)<(gasto_prev7d/mql_prev7d)*0.8 THEN 'MEJORANDO' ELSE 'ESTABLE' END as tendencia, ROUND(gasto_ayer) as gasto_ayer, CASE WHEN mql_ayer>0 THEN ROUND(gasto_ayer/mql_ayer) END as cpl_ayer, mql_ayer, ROUND(gasto_3d) as gasto_3d, CASE WHEN mql_3d>0 THEN ROUND(gasto_3d/mql_3d) END as cpl_3d, mql_3d, ROUND(gasto_sem) as gasto_sem, CASE WHEN mql_sem>0 THEN ROUND(gasto_sem/mql_sem) END as cpl_sem, mql_sem, ROUND(gasto_7d) as gasto_7d, CASE WHEN mql_7d>0 THEN ROUND(gasto_7d/mql_7d) END as cpl_7d, mql_7d FROM ventanas ORDER BY CASE WHEN mql_7d=0 AND gasto_7d>10000 THEN 1 WHEN mql_7d>0 AND mql_prev7d>0 AND (gasto_7d/mql_7d)>(gasto_prev7d/mql_prev7d)*2 THEN 1 WHEN mql_7d>0 AND mql_prev7d>0 AND (gasto_7d/mql_7d)>(gasto_prev7d/mql_prev7d)*1.5 THEN 2 WHEN mql_7d>0 AND mql_prev7d>0 AND (gasto_7d/mql_7d)<(gasto_prev7d/mql_prev7d)*0.8 THEN 4 WHEN mql_7d>0 THEN 3 ELSE 1 END, gasto_7d DESC LIMIT 30\n\nUsa esta query para preguntas sobre campanas criticas, rendimiento, estado general. Adapta filtros segun la pregunta.\n\nPara gasto simple: SELECT platform,ROUND(SUM(spend_with_iva)) as gasto,SUM(impressions) as imp,SUM(clicks) as clicks,SUM(mqls) as mqls FROM `" + GCP_PROJECT + "." + BQ_DATASET + ".rpt_campaign_performance_daily` WHERE date=DATE_SUB(CURRENT_DATE(),INTERVAL 1 DAY) GROUP BY 1\n\nPara CPL por diplomado: SELECT negocio,diplomado,platform,ROUND(SUM(spend_with_iva)) as gasto,SUM(mqls) as mqls,CASE WHEN SUM(mqls)>0 THEN ROUND(SUM(spend_with_iva)/SUM(mqls)) END as cpl FROM `" + GCP_PROJECT + "." + BQ_DATASET + ".rpt_campaign_performance_daily` WHERE date>=DATE_SUB(CURRENT_DATE(),INTERVAL 7 DAY) GROUP BY 1,2,3 HAVING gasto>10000 ORDER BY gasto DESC LIMIT 30\n\nPresenta resultados con emojis de estado, tablas markdown, y recomendaciones accionables.\n\nCONTEXTO DE UANDES ONLINE:\n- Universidad de los Andes (Chile), unidad de educacion continua online: https://uandesonline.cl/\n- Vende DIPLOMADOS y CURSOS para PROFESIONALES (tecnicos y universitarios) que buscan especializacion. NO vende carreras de pregrado.\n- Buyer persona: profesionales 25-55 anos con titulo universitario o tecnico que quieren especializarse, ascender o cambiar de area.\n- Facultades/areas: Medicina (nuevos y antiguos), Enfermeria, Derecho, Educacion, ICOM (negocios/gestion), ICF (infancia), Odontologia, CET (inmobiliaria)\n- COMPETIDORES DIRECTOS en educacion online Chile: PUC (Clase Ejecutiva), Universidad Adolfo Ibanez (UAI), Universidad de Chile, Universidad Andres Bello (UNAB), eClass\n- Mercado: educacion online/postgrado/diplomados en Chile y LATAM. Muy competitivo en Meta y Google Ads.\n- Estacionalidad: alta demanda en marzo (inicio ano academico) y julio-agosto (segundo semestre). Baja en diciembre-enero.\n\nBUSQUEDA WEB — Usa web_search cuando:\n- Pregunten POR QUE sube el CPL o baja rendimiento (factores: competencia, estacionalidad, noticias educacion)\n- Pidan recomendaciones estrategicas o benchmarks\n- Pregunten sobre competencia (PUC, UAI, UNAB, eClass)\n- Quieran entender tendencias del mercado de diplomados/educacion online\n- Busca en: emol.com, latercera.com, mineduc.cl, elmostrador.com, cooperativa.cl\n- CONTEXTO CORRECTO: habla de profesionales que buscan diplomados, NO de pacientes. UAndes vende educacion, no servicios de salud.\n\nCuando uses web_search, PRIMERO consulta BigQuery para datos internos, LUEGO busca contexto externo. Combina ambas fuentes.";

var BQ_TOOL = {
  name: "run_bigquery_query",
  description: "Ejecuta SQL en BigQuery. Tablas: `perfomance-490910.uandes_marketing.tabla`",
  input_schema: {
    type: "object",
    properties: { sql: { type: "string", description: "SQL BigQuery Standard" } },
    required: ["sql"],
  },
};

var WEB_SEARCH_TOOL = {
  type: "web_search_20250305",
  name: "web_search",
  max_uses: 3,
};

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
    // Limit history to prevent context bloat
    var currentMessages = messages.length > 4 ? messages.slice(-4) : messages.slice();
    var rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      console.log("[R" + rounds + "] calling Claude, msgs:" + currentMessages.length);

      var claudeResp = null;
      var retries = 0;
      // Force BQ tool on round 1, auto on subsequent (allows web search too)
      var toolChoice = rounds === 1 ? {type:"tool",name:"run_bigquery_query"} : {type:"auto"};
      var allTools = [BQ_TOOL, WEB_SEARCH_TOOL];
      while (retries < 2) {
        claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2048, system: SYSTEM_PROMPT, tools: allTools, tool_choice: toolChoice, messages: currentMessages }),
        });
        if (claudeResp.status === 529 && retries < 1) {
          console.log("[R" + rounds + "] 529 overloaded, retrying in 3s...");
          await new Promise(function(r){ setTimeout(r, 3000); });
          retries++;
          continue;
        }
        break;
      }

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
        var hasServerTools = false;
        for (var i = 0; i < cd.content.length; i++) {
          var b = cd.content[i];
          // Skip web_search server tool results — they're handled by the API automatically
          if (b.type === "server_tool_use" || b.type === "web_search_tool_result") {
            hasServerTools = true;
            continue;
          }
          if (b.type !== "tool_use") continue;
          
          if (b.name === "run_bigquery_query") {
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
          } else {
            results.push({ type:"tool_result", tool_use_id:b.id, content:JSON.stringify({error:"Unknown tool: " + b.name}), is_error:true });
          }
        }
        // Only push tool results if we have BQ results to send back
        if (results.length > 0) {
          currentMessages.push({ role: "user", content: results });
        }
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
