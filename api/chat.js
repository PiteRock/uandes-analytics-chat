import jwt from "jsonwebtoken";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GCP_PROJECT = "perfomance-490910";
const BQ_DATASET = "uandes_marketing";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 5;

let cachedToken = null;
let tokenExpiry = 0;

function parseServiceAccount() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error("Failed to parse GOOGLE_SERVICE_ACCOUNT_KEY: " + e.message);
  }
}

async function getAccessToken(sa) {
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/bigquery",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const assertion = jwt.sign(payload, sa.private_key, { algorithm: "RS256" });
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("OAuth2 token exchange failed (" + resp.status + "): " + errText);
  }
  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function runBigQueryQuery(sql, accessToken) {
  const url = "https://bigquery.googleapis.com/bigquery/v2/projects/" + GCP_PROJECT + "/queries";
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + accessToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: sql,
      useLegacySql: false,
      timeoutMs: 30000,
      maxResults: 100,
    }),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error("BigQuery error (" + resp.status + "): " + errText);
  }
  const result = await resp.json();
  if (result.errors && result.errors.length > 0) {
    throw new Error("BigQuery query errors: " + result.errors.map(function(e) { return e.message; }).join("; "));
  }
  if (!result.rows || result.rows.length === 0) {
    return {
      totalRows: "0",
      columns: result.schema ? result.schema.fields.map(function(f) { return f.name; }) : [],
      rows: [],
      message: "La query no retorno resultados.",
    };
  }
  var columns = result.schema.fields.map(function(f) { return f.name; });
  var rows = result.rows.map(function(row) {
    var obj = {};
    row.f.forEach(function(cell, i) { obj[columns[i]] = cell.v; });
    return obj;
  });
  return { totalRows: result.totalRows, columns: columns, rows: rows };
}

var SYSTEM_PROMPT = "Eres un analista de marketing digital experto en campanas de educacion online. Trabajas para UAndes Online y tienes acceso directo a BigQuery.\n\nDataset: " + GCP_PROJECT + "." + BQ_DATASET + "\n\nTablas:\n1. ads_hourly_unified - Gasto por hora x campana (2026). Cols: date, hour, platform ('meta'|'google'), campaign_name, campaign_id, cost_with_iva (CLP con IVA), impressions, clicks, reach, negocio, diplomado\n2. FBADS_AD - Meta Ads nivel anuncio (desde 9 mar 2026). Cols: DATE, AD_ID, AD_NAME, AD_GROUP_ID, AD_GROUP_NAME, CAMPAIGN_NAME, CREATIVE_BODY, CREATIVE_IMAGE_URL, COST (sin IVA), CLICKS, IMPRESSIONS, REACH\n3. GOOGLEADS_AD - Google Ads nivel anuncio. Cols: DATE, AD_ID, AD_TYPE, FINAL_URL, COST (sin IVA), CLICKS, IMPRESSIONS, CAMPAIGN_NAME\n4. GOOGLEADS_KEYWORD - Keywords. Cols: DATE, KEYWORD, QUALITY_SCORE, MATCH_TYPE, COST (sin IVA), CLICKS, IMPRESSIONS, CAMPAIGN_NAME\n5. GOOGLEADS_SEARCH_QUERY - Search terms. Cols: DATE, SEARCH_TERM, KEYWORD, COST (sin IVA), CLICKS, CONVERSIONS, CAMPAIGN_NAME\n6. stg_hubspot_contacts_attributed - Leads HubSpot. Cols: create_date (TIMESTAMP), detected_platform, extracted_meta_adset_id, extracted_google_campaign_id, conversion_mql (BOOLEAN)\n7. vw_ads_all_time - Vista 2025+2026 (~208K filas)\n8. dim_diplomado_mapping - Mapeo campana a diplomado a negocio (212 filas)\n\nREGLAS CRITICAS:\n- FBADS_AD/GOOGLEADS_*: COST sin IVA, multiplicar x 1.19\n- ads_hourly_unified: cost_with_iva ya incluye IVA\n- CPL = Gasto con IVA / MQLs (conversion_mql=true). NUNCA dividas por leads totales.\n- CPL es la METRICA PRINCIPAL, no CPC. Para preguntas generales, analiza CPL.\n- Gasto con CERO MQLs = situacion CRITICA, priorizar sobre CPL alto.\n- Usa dim_diplomado_mapping para agrupar por diplomado/negocio.\n- CPL historico se calcula POR DIPLOMADO.\n- Estados: CRITICO (CPL>200% historico), ALERTA (50-200%), ESTABLE (-20% a +50%), BIEN (<-20%)\n- Califica tablas: `" + GCP_PROJECT + "." + BQ_DATASET + ".tabla`\n- Usa LIMIT. Responde en espanol. Montos CLP con punto separador miles.\n- No inventes datos. Si no puedes responder, explica por que.";

var TOOLS = [
  {
    name: "run_bigquery_query",
    description: "Ejecuta SQL en BigQuery. Usa nombres calificados: `perfomance-490910.uandes_marketing.tabla`",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "Query SQL BigQuery Standard. Usa backticks para tabla: `perfomance-490910.uandes_marketing.tabla`",
        },
      },
      required: ["sql"],
    },
  },
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    var body = req.body;
    var messages = body.messages;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages array is required" });
    }
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured" });
    }

    var sa = parseServiceAccount();
    var accessToken = await getAccessToken(sa);
    var currentMessages = messages.slice();
    var rounds = 0;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      console.log("[LOOP] Round " + rounds + " starting");

      var claudeResp = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: currentMessages,
        }),
      });

      if (!claudeResp.ok) {
        var errText = await claudeResp.text();
        console.error("[CLAUDE] Error " + claudeResp.status + ":", errText.substring(0, 300));
        return res.status(502).json({
          error: "Error al comunicarse con Claude (" + claudeResp.status + ")",
          detail: errText.substring(0, 200),
        });
      }

      var claudeData = await claudeResp.json();
      console.log("[LOOP] Round " + rounds + " stop_reason: " + claudeData.stop_reason);

      if (claudeData.stop_reason === "end_turn" || claudeData.stop_reason === "max_tokens") {
        var textContent = claudeData.content
          .filter(function(block) { return block.type === "text"; })
          .map(function(block) { return block.text; })
          .join("\n");
        return res.status(200).json({ response: textContent });
      }

      if (claudeData.stop_reason === "tool_use") {
        currentMessages.push({
          role: "assistant",
          content: claudeData.content,
        });

        var toolResults = [];
        for (var i = 0; i < claudeData.content.length; i++) {
          var block = claudeData.content[i];
          if (block.type !== "tool_use") continue;

          if (block.name === "run_bigquery_query") {
            var sql = block.input ? block.input.sql : null;
            if (!sql) {
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({ error: "No SQL query provided" }),
                is_error: true,
              });
              continue;
            }
            try {
              console.log("[BQ] Round " + rounds + ":", sql.substring(0, 200));
              var queryResult = await runBigQueryQuery(sql, accessToken);
              var resultStr = JSON.stringify(queryResult);
              if (resultStr.length > 15000) {
                queryResult.rows = queryResult.rows.slice(0, 50);
                queryResult.truncated = true;
                queryResult.note = "Truncado a 50 filas. Usa LIMIT o filtros mas especificos.";
                resultStr = JSON.stringify(queryResult);
              }
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: resultStr,
              });
            } catch (bqError) {
              console.error("[BQ] Failed:", bqError.message);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({
                  error: bqError.message,
                  hint: "Revisa sintaxis SQL y nombres de tabla/columnas.",
                }),
                is_error: true,
              });
            }
          } else {
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify({ error: "Unknown tool: " + block.name }),
              is_error: true,
            });
          }
        }

        currentMessages.push({ role: "user", content: toolResults });
        continue;
      }

      // Unexpected stop_reason
      var fallbackText = claudeData.content
        ? claudeData.content.filter(function(b) { return b.type === "text"; }).map(function(b) { return b.text; }).join("\n")
        : "No se pudo generar una respuesta.";
      return res.status(200).json({ response: fallbackText });
    }

    return res.status(200).json({
      response: "Se alcanzo el limite de consultas internas. Reformula tu pregunta.",
    });
  } catch (err) {
    console.error("[FATAL]", err);
    return res.status(500).json({
      error: "Error interno del servidor",
      detail: err.message,
    });
  }
}
