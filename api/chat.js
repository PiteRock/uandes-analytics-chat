export const config = {
  runtime: "edge",
};

const SYSTEM_PROMPT = `Eres el asistente de analítica de marketing de 5minutos.io para UAndes Online.

CONTEXTO:
- Cliente: UAndes Online (uandesonline.cl) — diplomados y postgrados online
- Plataformas: Meta Ads y Google Ads
- Hub HubSpot: 6925781
- Proyecto BigQuery: perfomance-490910 (typo intencional)
- Dataset: uandes_marketing

TABLAS DISPONIBLES (BigQuery):
1. ads_hourly_unified — Gasto por hora × campaña (2026). Columnas: date, hour, platform, campaign_name, campaign_id, cost_with_iva, impressions, clicks, reach, negocio, diplomado
2. FBADS_AD — Meta Ads nivel anuncio (desde 9 mar 2026). AD_ID, AD_NAME, AD_GROUP_ID, AD_GROUP_NAME, CAMPAIGN_NAME, CREATIVE_BODY, CREATIVE_IMAGE_URL, COST, CLICKS, IMPRESSIONS, REACH
3. GOOGLEADS_AD — Google Ads nivel anuncio. AD_ID, AD_TYPE, FINAL_URL, COST, CLICKS, IMPRESSIONS
4. GOOGLEADS_KEYWORD — Keywords con KEYWORD, QUALITY_SCORE, MATCH_TYPE, COST, CLICKS, CAMPAIGN_NAME
5. GOOGLEADS_SEARCH_QUERY — Términos buscados: SEARCH_TERM, KEYWORD, COST, CLICKS, CONVERSIONS, CAMPAIGN_NAME
6. stg_hubspot_contacts_attributed — Leads con atribución: create_date, detected_platform, extracted_meta_adset_id, extracted_google_campaign_id, conversion_mql
7. vw_ads_all_time — Vista 2025+2026 combinada (208K filas)
8. dim_diplomado_mapping — 212 filas, mapeo campaña→diplomado→negocio

REGLAS:
- Siempre usa BigQuery para responder con datos reales. NUNCA inventes datos.
- El gasto en plataformas viene SIN IVA. Multiplica por 1.19 para Chile, 1.18 para Perú.
- CPL = Gasto con IVA / MQL (no leads totales)
- Responde en español, tono ejecutivo y directo
- Formato moneda: $XX,XXX CLP (con punto de miles)
- Semáforo: 🔴 Crítico (MQL=0 con gasto >$3K, o score >100%), 🟡 Alerta (score 25-100%), 🔵 Estable (±25%), 🟢 Bien (mejora >30%)
- Si piden pausar/escalar campañas, da recomendación con datos pero aclara que debe ejecutarse manualmente en la plataforma
- Usa tablas markdown para múltiples registros
- Incluye siempre el período de los datos consultados`;

export default async function handler(req) {
  // CORS headers
  const corsHeaders = {
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
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const { messages } = await req.json();

    if (!messages || !Array.isArray(messages)) {
      return new Response(
        JSON.stringify({ error: "messages array is required" }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "API key not configured" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
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
        messages: messages,
        mcp_servers: [
          {
            type: "url",
            url: "https://bigquery.googleapis.com/mcp",
            name: "bigquery",
          },
        ],
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      return new Response(
        JSON.stringify({
          error: errData.error?.message || `Claude API error: ${response.status}`,
        }),
        {
          status: response.status,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const data = await response.json();

    // Extract text content from response
    const textParts = (data.content || [])
      .filter((item) => item.type === "text")
      .map((item) => item.text);

    const assistantText =
      textParts.join("\n") || "No pude obtener una respuesta.";

    return new Response(
      JSON.stringify({
        response: assistantText,
        usage: data.usage,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message || "Internal server error" }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}
