export const config = {
  runtime: "edge",
};

const SYSTEM_PROMPT = `Eres el asistente de analítica de marketing de 5minutos.io para UAndes Online.

CONTEXTO:
- Cliente: UAndes Online (uandesonline.cl) — diplomados y postgrados online
- Plataformas: Meta Ads y Google Ads
- Proyecto BigQuery: perfomance-490910 (typo intencional)
- Dataset: uandes_marketing

TABLAS DISPONIBLES:
1. ads_hourly_unified — Gasto por hora x campaña (2026). Columnas: date, hour, platform, campaign_name, campaign_id, cost_with_iva, impressions, clicks, reach, negocio, diplomado
2. FBADS_AD — Meta Ads nivel anuncio (desde 9 mar 2026). AD_ID, AD_NAME, AD_GROUP_ID, AD_GROUP_NAME, CAMPAIGN_NAME, CREATIVE_BODY, CREATIVE_IMAGE_URL, COST, CLICKS, IMPRESSIONS, REACH
3. GOOGLEADS_AD — Google Ads nivel anuncio. AD_ID, AD_TYPE, FINAL_URL, COST, CLICKS, IMPRESSIONS
4. GOOGLEADS_KEYWORD — Keywords con KEYWORD, QUALITY_SCORE, MATCH_TYPE, COST, CLICKS, CAMPAIGN_NAME
5. GOOGLEADS_SEARCH_QUERY — Terminos buscados: SEARCH_TERM, KEYWORD, COST, CLICKS, CONVERSIONS, CAMPAIGN_NAME
6. stg_hubspot_contacts_attributed — Leads con atribucion: create_date, detected_platform, extracted_meta_adset_id, extracted_google_campaign_id, conversion_mql
7. vw_ads_all_time — Vista 2025+2026 combinada (208K filas)
8. dim_diplomado_mapping — 212 filas, mapeo campana a diplomado a negocio

REGLAS:
- Genera queries SQL para BigQuery cuando necesites datos. Usa la tool run_bigquery_query.
- Todas las tablas estan en perfomance-490910.uandes_marketing
- El gasto en plataformas viene SIN IVA. Multiplica por 1.19 para Chile.
- CPL = Gasto con IVA / MQL (no leads totales)
- Responde en espanol, tono ejecutivo y directo
- Formato moneda: $XX,XXX CLP
- Semaforo: Critico (MQL=0 con gasto mayor a $3K, o score mayor a 100%), Alerta (score 25-100%), Estable (mas menos 25%), Bien (mejora mayor a 30%)
- Si piden pausar/escalar campanas, da recomendacion con datos pero aclara que debe ejecutarse manualmente
- Usa tablas markdown para multiples registros
- Incluye siempre el periodo de los datos`;

const TOOLS = [
  {
    name: "run_bigquery_query",
    description: "Ejecuta una query SQL en BigQuery contra el proyecto perfomance-490910. Usa GoogleSQL. Solo SELECT statements. Todas las tablas estan en el dataset uandes_marketing.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Query SQL en GoogleSQL para ejecutar en BigQuery. Ejemplo: SELECT date, SUM(cost_with_iva) FROM perfomance-490910.uandes_marketing.ads_hourly_unified WHERE platform = 'Meta' GROUP BY date ORDER BY date DESC LIMIT 7"
        }
      },
      required: ["query"]
    }
  }
];

async function getAccessToken(serviceAccountKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: serviceAccountKey.client_email,
    scope: "https://www.googleapis.com/auth/bigquery.readonly",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = btoa(JSON.stringify(header))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const encodedPayload = btoa(JSON.stringify(payload))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const signInput = encodedHeader + "." + encodedPayload;

  const pemContent = serviceAccountKey.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");

  const binaryKey = Uint8Array.from(atob(pemContent), function(c) { return c.charCodeAt(0); });

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    binaryKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signInput)
  );

  const encodedSignature = btoa(String.fromCharCode.apply(null, new Uint8Array(signature)))
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

  const jwt = signInput + "." + encodedSignature;

  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
  });

  const tokenData = await tokenResponse.json();
  if (!tokenData.access_token) {
    throw new Error("Token error: " + JSON.stringify(tokenData));
  }
  return tokenData.access_token;
}

async function runBigQuery(query, serviceAccountKey) {
  const token = await getAccessToken(serviceAccountKey);

  const bqResponse = await fetch(
    "https://bigquery.googleapis.com/bigquery/v2/projects/perfomance-490910/queries",
    {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query,
        useLegacySql: false,
        maxResults: 500,
        timeoutMs: 30000,
      }),
    }
  );

  if (!bqResponse.ok) {
    const bqErr = await bqResponse.text();
    return { error: "BigQuery error: " + bqErr };
  }

  const bqData = await bqResponse.json();

  if (bqData.rows && bqData.schema) {
    var headers = bqData.schema.fields.map(function(f) { return f.name; });
    var rows = bqData.rows.map(function(r) {
      var obj = {};
      r.f.forEach(function(cell, i) {
        obj[headers[i]] = cell.v;
      });
      return obj;
    });
    return { headers: headers, rows: rows, totalRows: bqData.totalRows };
  } else {
    return { headers: [], rows: [], totalRows: "0", note: "Query returned no results" };
  }
}

export default async function handler(req) {
  var corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }),
    });
  }

  try {
    var body = await req.json();
    var messages = body.messages;

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: "messages array is required" }),
        { status: 400, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }) }
      );
    }

    var apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "API key not configured" }),
        { status: 500, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }) }
      );
    }

    var serviceAccountKey = null;
    if (process.env.GOOGLE_SERVICE_ACCOUNT_KEY) {
      try {
        serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
      } catch (e) {
        // Invalid JSON in service account key
      }
    }

    var currentMessages = messages.slice();
    var finalText = "";
    var iterations = 0;

    while (iterations < 5) {
      iterations++;

      var response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: currentMessages,
          tools: TOOLS,
        }),
      });

      if (!response.ok) {
        var errData = {};
        try { errData = await response.json(); } catch(e) {}
        throw new Error((errData.error && errData.error.message) || ("API error: " + response.status));
      }

      var data = await response.json();
      var content = data.content || [];

      var toolUseBlocks = content.filter(function(b) { return b.type === "tool_use"; });
      var textBlocks = content.filter(function(b) { return b.type === "text"; });

      if (toolUseBlocks.length === 0) {
        finalText = textBlocks.map(function(b) { return b.text; }).join("\n");
        break;
      }

      currentMessages.push({ role: "assistant", content: content });

      var toolResults = [];
      for (var i = 0; i < toolUseBlocks.length; i++) {
        var toolUse = toolUseBlocks[i];

        if (toolUse.name === "run_bigquery_query") {
          var result;

          if (serviceAccountKey) {
            try {
              result = await runBigQuery(toolUse.input.query, serviceAccountKey);
            } catch (e) {
              result = { error: "BigQuery execution error: " + e.message };
            }
          } else {
            result = {
              error: "BigQuery no configurado. Agrega GOOGLE_SERVICE_ACCOUNT_KEY en Vercel.",
              query_attempted: toolUse.input.query
            };
          }

          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: JSON.stringify(result),
          });
        }
      }

      currentMessages.push({ role: "user", content: toolResults });
    }

    if (!finalText) {
      finalText = "No pude obtener una respuesta.";
    }

    return new Response(
      JSON.stringify({ response: finalText }),
      { status: 200, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }) }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      { status: 500, headers: Object.assign({}, corsHeaders, { "Content-Type": "application/json" }) }
    );
  }
}
