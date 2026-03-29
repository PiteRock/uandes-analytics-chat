import jwt from "jsonwebtoken";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GCP_PROJECT = "perfomance-490910";
const BQ_DATASET = "uandes_marketing";
const CLAUDE_MODEL = "claude-sonnet-4-20250514";
const MAX_TOOL_ROUNDS = 5;

// ─── BIGQUERY AUTH ────────────────────────────────────────────────────────────
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

// ─── BIGQUERY QUERY ───────────────────────────────────────────────────────────
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
      maxResults: 500,
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

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────
var SYSTEM_PROMPT = "Eres un analista de marketing digital experto en campanas de educacion online. Trabajas para UAndes Online y tienes acceso directo a su data warehouse en BigQuery.\n\n## Dataset: " + GCP_PROJECT + "." + BQ_DATASET + "\n\n### Tablas disponibles:\n\n1. **ads_hourly_unified** — Gasto por hora x campana (2026)\n   Columnas: date (DATE), hour (INT), platform (STRING: 'meta'|'google'), campaign_name, campaign_id, cost_with_iva (FLOAT, pesos CLP con IVA), impressions, clicks, reach, negocio, diplomado\n\n2. **FBADS_AD** — Meta Ads nivel anuncio (desde 9 mar 2026)\n   Columnas: DATE (DATE), AD_ID, AD_NAME, AD_GROUP_ID, AD_GROUP_NAME, CAMPAIGN_NAME, CREATIVE_BODY, CREATIVE_IMAGE_URL, COST (FLOAT, sin IVA), CLICKS, IMPRESSIONS, REACH\n\n3. **GOOGLEADS_AD** — Google Ads nivel anuncio\n   Columnas: DATE (DATE), AD_ID, AD_TYPE, FINAL_URL, COST (FLOAT, sin IVA), CLICKS, IMPRESSIONS, CAMPAIGN_NAME\n\n4. **GOOGLEADS_KEYWORD** — Keywords (4,992 filas)\n   Columnas: DATE, KEYWORD, QUALITY_SCORE, MATCH_TYPE, COST (sin IVA), CLICKS, IMPRESSIONS, CAMPAIGN_NAME\n\n5. **GOOGLEADS_SEARCH_QUERY** — Terminos buscados (25,398 filas)\n   Columnas: DATE, SEARCH_TERM, KEYWORD, COST (sin IVA), CLICKS, CONVERSIONS, CAMPAIGN_NAME\n\n6. **stg_hubspot_contacts_attributed** — Leads con atribucion\n   Columnas: create_date (TIMESTAMP), detected_platform, extracted_meta_adset_id, extracted_google_campaign_id, conversion_mql (BOOLEAN)\n\n7. **vw_ads_all_time** — Vista combinada 2025+2026 (~208K filas)\n\n8. **dim_diplomado_mapping** — Mapeo campana a diplomado a negocio (212 filas)\n\n## Reglas de negocio CRITICAS:\n- **Gasto en FBADS_AD y GOOGLEADS_***: viene SIN IVA. Multiplicar COST x 1.19 para obtener gasto real en Chile.\n- **ads_hourly_unified**: ya tiene cost_with_iva (incluye IVA).\n- **CPL** = Gasto con IVA / cantidad de MQL (donde conversion_mql = true). NO dividir por leads totales.\n- Siempre califica dataset completo: `" + GCP_PROJECT + "." + BQ_DATASET + ".nombre_tabla`\n- Limita resultados con LIMIT cuando sea apropiado para no sobrecargar.\n- Si necesitas cruzar ads con leads, usa stg_hubspot_contacts_attributed.\n- Responde SIEMPRE en espanol.\n- Formatea montos en CLP con separador de miles (punto) y sin decimales.\n- Cuando muestres tablas, usa formato markdown.\n- Si no estas seguro de algo, dilo. No inventes datos.\n- Si una pregunta no puede responderse con los datos disponibles, explica por que.";

var TOOLS = [
  {
    name: "run_bigquery_query",
    description: "Ejecuta una query SQL en Google BigQuery contra el dataset de marketing de UAndes. Usa esta herramienta para consultar datos de campanas, gastos, leads, keywords y metricas de performance. Siempre usa nombres de tabla completamente calificados: perfomance-490910.uandes_marketing.nombre_tabla",
    input_schema: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "Query SQL compatible con BigQuery Standard SQL. Usa backticks para proyecto.dataset.tabla: `perfomance-490910.uandes_marketing.tabla`",
        },
      },
      required: ["sql"],
    },
  },
];

// ─── NON-STREAMING CLAUDE CALL (for tool-use rounds) ─────────────────────────
async function callClaude(messages) {
  var resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: messages,
    }),
  });
  if (!resp.ok) {
    var errText = await resp.text();
    throw new Error("Claude API error (" + resp.status + "): " + errText.substring(0, 300));
  }
  return resp.json();
}

// ─── SSE HELPER ───────────────────────────────────────────────────────────────
function sseWrite(res, event, data) {
  res.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
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

    // Set up SSE
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    var currentMessages = messages.slice();
    var rounds = 0;

    // Phase 1: Tool-use loop (non-streaming) to resolve all BigQuery queries
    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      var claudeData = await callClaude(currentMessages);

      if (claudeData.stop_reason === "end_turn") {
        // Final answer arrived (no streaming needed, tools already resolved)
        var textContent = claudeData.content
          .filter(function(block) { return block.type === "text"; })
          .map(function(block) { return block.text; })
          .join("\n");
        // Simulate streaming by chunking the text
        var chunkSize = 12;
        for (var ci = 0; ci < textContent.length; ci += chunkSize) {
          sseWrite(res, "text", { text: textContent.slice(ci, ci + chunkSize) });
        }
        sseWrite(res, "done", {});
        res.end();
        return;
      }

      if (claudeData.stop_reason === "tool_use") {
        sseWrite(res, "status", { message: "Consultando BigQuery..." });

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
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify(queryResult),
              });
              sseWrite(res, "status", { message: "Datos obtenidos, analizando..." });
            } catch (bqError) {
              console.error("[BQ] Failed:", bqError.message);
              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: JSON.stringify({
                  error: bqError.message,
                  hint: "Revisa la sintaxis SQL, nombres de tabla y columnas.",
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

      // Unexpected stop_reason — send whatever we got
      var fallbackText = claudeData.content
        ? claudeData.content.filter(function(b) { return b.type === "text"; }).map(function(b) { return b.text; }).join("\n")
        : "No se pudo generar una respuesta.";
      sseWrite(res, "text", { text: fallbackText });
      sseWrite(res, "done", {});
      res.end();
      return;
    }

    // Exhausted tool rounds
    sseWrite(res, "text", { text: "Se alcanzo el limite de consultas. Reformula tu pregunta de forma mas especifica." });
    sseWrite(res, "done", {});
    res.end();

  } catch (err) {
    console.error("[FATAL]", err);
    if (res.headersSent) {
      sseWrite(res, "error", { message: err.message });
      res.end();
    } else {
      res.status(500).json({ error: "Error interno del servidor", detail: err.message });
    }
  }
}
