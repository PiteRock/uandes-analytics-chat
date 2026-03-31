// api/chat.js — UAndes Analytics Chat (Vercel Serverless Function)
// Stack: Claude API (tool-use + web search), BigQuery, ESM
// Produces CAUSAL and OPERATIVE analysis, not descriptive.

import jwt from 'jsonwebtoken';

export const config = { maxDuration: 60 };

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const BQ_PROJECT = 'perfomance-490910';
const BQ_DATASET = 'uandes_marketing';
const MAX_TOOL_ROUNDS = 5;
const MAX_BQ_ROWS = 30;
const MAX_BQ_BYTES = 12000;
const MAX_WEB_SEARCHES = 3;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

// ─── BigQuery OAuth Token Cache ─────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;

async function getBQToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign(
    {
      iss: sa.client_email,
      sub: sa.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/bigquery.readonly',
    },
    sa.private_key,
    { algorithm: 'RS256' }
  );

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
  });

  const data = await resp.json();
  if (!data.access_token) throw new Error('BQ auth failed: ' + JSON.stringify(data));
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

// ─── BigQuery Query Execution ───────────────────────────────────────────────
async function runBigQuery(sql) {
  const token = await getBQToken();
  const resp = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_PROJECT}/queries`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: sql,
        useLegacySql: false,
        maxResults: 100,
        timeoutMs: 30000,
      }),
    }
  );

  const data = await resp.json();
  if (data.error) return { error: data.error.message || JSON.stringify(data.error) };
  if (!data.jobComplete) return { error: 'Query timeout after 30s' };

  const fields = (data.schema?.fields || []).map((f) => f.name);
  const rows = (data.rows || []).map((r) =>
    Object.fromEntries(fields.map((f, i) => [f, r.f[i].v]))
  );

  // Truncate
  let result = rows.slice(0, MAX_BQ_ROWS);
  let resultStr = JSON.stringify(result);
  if (resultStr.length > MAX_BQ_BYTES) {
    while (result.length > 1 && JSON.stringify(result).length > MAX_BQ_BYTES) {
      result.pop();
    }
    resultStr = JSON.stringify(result);
  }

  return {
    total_rows: data.totalRows,
    returned_rows: result.length,
    truncated: rows.length > result.length,
    columns: fields,
    data: result,
  };
}

// ─── TODAY helper ───────────────────────────────────────────────────────────
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const today = getToday();
  return `Eres el analista de performance digital de UAndes Online. Hoy es ${today}.

## ROL Y OBJETIVO
Produces análisis CAUSAL y OPERATIVO. No descriptivo. Cada respuesta debe identificar QUÉ está pasando, POR QUÉ está pasando (causa raíz), y QUÉ HACER (acción concreta con condiciones).

## REGLA DE ORO
NUNCA digas frases genéricas como "alta competencia publicitaria", "saturación del mercado" o "pausar campañas con CPL alto". SIEMPRE respalda con datos exactos y descomposición de métricas.

## DESCOMPOSICIÓN OBLIGATORIA DEL CPL
Para cada campaña o grupo analizado, SIEMPRE descomponer el CPL en sus componentes para diagnosticar la CAUSA:

| Métrica | Fórmula | Qué diagnostica |
|---------|---------|-----------------|
| CPC | spend/clicks | Problema de SUBASTA (competencia en bids) |
| CTR | clicks/impressions×100 | Problema de CREATIVIDAD o RELEVANCIA del anuncio |
| CPM | (spend/impressions)×1000 | Presión COMPETITIVA en el inventario publicitario |
| Frecuencia | impressions/reach | FATIGA de audiencia (>3 = alerta, >5 = crítico) |
| CVR | leads/clicks×100 | Problema de LANDING PAGE o calidad de tráfico |
| MQL Rate | mqls/leads×100 | Problema de CALIFICACIÓN o segmentación |
| CPL | spend/mqls | Resultado final (consecuencia, no causa) |

## ESTRUCTURA OBLIGATORIA POR CAMPAÑA
1. **Campaña**: nombre exacto
2. **Métricas**: CPL, CPC, CTR, CVR, CPM, Frecuencia (valores actuales)
3. **Variación vs período anterior**: % cambio de cada métrica
4. **Problema principal**: subasta / creatividad / landing / fatiga / segmentación
5. **Evidencia cuantitativa**: los números que prueban el diagnóstico
6. **Causa fundamentada**: explicación causal basada en los datos
7. **Acción concreta**: qué hacer + condición de aplicación + resultado esperado

## FORMATO DE OUTPUT
- Usa tablas markdown para comparaciones multi-campaña
- Usa negrita para métricas críticas
- Usa emoji ⚠️ para alertas, 🔴 para crítico, 🟡 para atención, 🟢 para OK
- Ordena siempre por severidad (más crítico primero)

## REGLAS DE DIAGNÓSTICO CAUSAL
- CPL sube + CPC sube + CTR estable → Problema de SUBASTA → Ajustar bids o cambiar estrategia de puja
- CPL sube + CTR baja + CPC estable → Problema de CREATIVIDAD → Rotar creatividades/copy
- CPL sube + CVR baja + CPC estable → Problema de LANDING PAGE → Optimizar landing/formulario
- CPL sube + Frecuencia >3 → FATIGA de audiencia → Ampliar audiencia o rotar creatividades
- CPL sube + CPM sube + todo lo demás estable → Presión COMPETITIVA → Evaluar horarios/segmentos menos competidos
- Gasto sin MQL → CRÍTICO: si tiene leads pero no MQL, problema de calificación. Si no tiene leads, problema de CVR.

## ACCIONES CONCRETAS (no genéricas)
Cada acción debe incluir:
- Campaña específica (nombre exacto)
- Condición: "Si CPL > $X Y CVR < Y%"
- Acción: verbo imperativo + detalle ("Pausar", "Reducir bid 20%", "Rotar creatividad", "Ampliar audiencia lookalike 3%→5%")
- Motivo: la causa diagnosticada
- Prioridad: Alta/Media/Baja

## BigQuery - PROYECTO Y TABLAS
Proyecto: \`${BQ_PROJECT}\`
Dataset: \`${BQ_DATASET}\`

### Tabla principal: rpt_campaign_performance_daily
Columnas: date (DATE), platform ('Meta'|'Google'), campaign_id, campaign_name, diplomado, negocio, spend_with_iva (FLOAT64), spend_without_iva, impressions (INT64), clicks (INT64), reach (INT64), pixel_leads (FLOAT64), leads (INT64), mqls (INT64), matriculados (INT64), matriculados_activos (INT64), revenue (FLOAT64), revenue_activo (FLOAT64), cpl_with_iva (FLOAT64), cpmql_with_iva (FLOAT64), cac_with_iva (FLOAT64), roas (FLOAT64), mql_rate (FLOAT64), conversion_rate (FLOAT64), cpl_status (STRING)

### Tabla FBADS_AD (detalle Meta Ads a nivel de anuncio)
Columnas clave: DATE, CAMPAIGN_NAME, AD_GROUP_NAME, AD_NAME, COST (FLOAT64), CLICKS (INT64), IMPRESSIONS (INT64), REACH (INT64), LANDING_PAGE_VIEWS (INT64), OFFSITE_CONVERSIONS_FB_PIXEL_LEAD (INT64), OUTBOUND_CLICKS (INT64), CREATIVE_BODY, CREATIVE_TITLE, CREATIVE_IMAGE_URL

### Tabla GOOGLEADS_KEYWORD
Columnas clave: DATE, CAMPAIGN_NAME, KEYWORD, MATCH_TYPE, QUALITY_SCORE (INT64), CLICKS, IMPRESSIONS, CONVERSIONS (FLOAT64), COST (FLOAT64)

### Tabla GOOGLEADS_SEARCH_QUERY
Columnas clave: DATE, CAMPAIGN_NAME, SEARCH_TERM, KEYWORD, CLICKS, IMPRESSIONS, CONVERSIONS (FLOAT64), COST (FLOAT64)

### Tabla ads_hourly_unified (análisis por hora)
Columnas clave: date, hour, platform, campaign_name, cost_with_iva, clicks, impressions, reach

### Negocios válidos
'Medicina Nuevos', 'Medicina Antiguos', 'Enfermería', 'Derecho', 'Educación', 'ICOM', 'ICF', 'ADS Medicina/Gestion ADS', 'ADS Educación', 'CET/Gestion Inmobiliaria', 'UDEP (Peru)', 'Magister', 'Odontologia'
(también hay ~777 filas con negocio NULL)

## QUERIES RECOMENDADAS

### Query de diagnóstico completo (USAR SIEMPRE para análisis de campañas)
\`\`\`sql
WITH periodo_actual AS (
  SELECT campaign_name, negocio, diplomado, platform,
    ROUND(SUM(spend_with_iva)) as gasto,
    SUM(clicks) as clicks,
    SUM(impressions) as imp,
    SUM(reach) as reach,
    SUM(leads) as leads,
    SUM(mqls) as mqls,
    ROUND(SUM(spend_with_iva)/NULLIF(SUM(clicks),0)) as cpc,
    ROUND(SUM(clicks)*100.0/NULLIF(SUM(impressions),0),2) as ctr,
    ROUND(SUM(spend_with_iva)*1000/NULLIF(SUM(impressions),0)) as cpm,
    ROUND(SUM(impressions)*1.0/NULLIF(SUM(reach),0),1) as freq,
    ROUND(SUM(leads)*100.0/NULLIF(SUM(clicks),0),2) as cvr,
    CASE WHEN SUM(mqls)>0 THEN ROUND(SUM(spend_with_iva)/SUM(mqls)) END as cpl
  FROM \`${BQ_PROJECT}.${BQ_DATASET}.rpt_campaign_performance_daily\`
  WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  GROUP BY 1,2,3,4
),
periodo_anterior AS (
  SELECT campaign_name, platform,
    ROUND(SUM(spend_with_iva)/NULLIF(SUM(clicks),0)) as cpc_prev,
    ROUND(SUM(clicks)*100.0/NULLIF(SUM(impressions),0),2) as ctr_prev,
    ROUND(SUM(spend_with_iva)*1000/NULLIF(SUM(impressions),0)) as cpm_prev,
    ROUND(SUM(impressions)*1.0/NULLIF(SUM(reach),0),1) as freq_prev,
    ROUND(SUM(leads)*100.0/NULLIF(SUM(clicks),0),2) as cvr_prev,
    CASE WHEN SUM(mqls)>0 THEN ROUND(SUM(spend_with_iva)/SUM(mqls)) END as cpl_prev
  FROM \`${BQ_PROJECT}.${BQ_DATASET}.rpt_campaign_performance_daily\`
  WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)
    AND date < DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  GROUP BY 1,2
)
SELECT a.*, b.cpc_prev, b.ctr_prev, b.cpm_prev, b.freq_prev, b.cvr_prev, b.cpl_prev,
  ROUND((a.cpc - b.cpc_prev)*100.0/NULLIF(b.cpc_prev,0),1) as cpc_var_pct,
  ROUND((a.ctr - b.ctr_prev)*100.0/NULLIF(b.ctr_prev,0),1) as ctr_var_pct,
  ROUND((a.cpm - b.cpm_prev)*100.0/NULLIF(b.cpm_prev,0),1) as cpm_var_pct
FROM periodo_actual a
LEFT JOIN periodo_anterior b ON a.campaign_name = b.campaign_name AND a.platform = b.platform
WHERE a.gasto > 0
ORDER BY a.gasto DESC
\`\`\`

### Query para gasto sin MQL (campañas CRÍTICAS)
\`\`\`sql
SELECT campaign_name, negocio, platform,
  ROUND(SUM(spend_with_iva)) as gasto,
  SUM(clicks) as clicks, SUM(leads) as leads, SUM(mqls) as mqls,
  ROUND(SUM(spend_with_iva)/NULLIF(SUM(clicks),0)) as cpc,
  ROUND(SUM(leads)*100.0/NULLIF(SUM(clicks),0),2) as cvr,
  CASE
    WHEN SUM(leads) = 0 THEN 'SIN_LEADS: problema de CVR/landing'
    WHEN SUM(mqls) = 0 AND SUM(leads) > 0 THEN 'SIN_MQL: problema de calificación'
    ELSE 'OK'
  END as diagnostico
FROM \`${BQ_PROJECT}.${BQ_DATASET}.rpt_campaign_performance_daily\`
WHERE date >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)
  AND spend_with_iva > 0
GROUP BY 1,2,3
HAVING SUM(mqls) = 0
ORDER BY gasto DESC
\`\`\`

## REGLAS DE SQL
- Siempre usar backticks: \`${BQ_PROJECT}.${BQ_DATASET}.tabla\`
- platform es STRING: 'Meta' o 'Google' (con mayúscula)
- Fechas: DATE type, usar DATE_SUB(CURRENT_DATE(), INTERVAL N DAY)
- mqls es INT64 (no boolean)
- Montos en CLP (pesos chilenos). Formatear con separador de miles.
- NUNCA usar LIMIT < 20 en análisis generales (pierde información)
- Usar NULLIF para evitar división por cero
- Para comparaciones, SIEMPRE incluir período anterior (WoW o similar)

## CONTEXTO DE NEGOCIO
- UAndes Online vende diplomados y cursos para profesionales (25-55 años)
- Estacionalidad: alta en marzo y julio-agosto, baja diciembre-enero
- CPL = spend_with_iva / mqls (métrica principal del cliente)
- MQL = lead calificado por equipo comercial
- Competidores: PUC (Clase Ejecutiva), UAI, U de Chile, UNAB, eClass
- Moneda: CLP (pesos chilenos)

## INSTRUCCIONES DE HERRAMIENTAS
1. SIEMPRE ejecutar al menos una query BigQuery antes de responder a preguntas sobre datos
2. Si el usuario pregunta algo genérico como "cómo van las campañas", usar la query de diagnóstico completo
3. Usar web_search SOLO para contexto de mercado educativo, tendencias de costo en Chile, o competencia
4. Máximo ${MAX_WEB_SEARCHES} búsquedas web por consulta
5. Responder SIEMPRE en español

## LO QUE NUNCA DEBES HACER
❌ Frases vagas: "hay alta competencia", "el mercado está saturado", "se recomienda optimizar"
❌ Análisis sin datos: nunca opinar sin haber ejecutado query
❌ Acciones genéricas: "pausar campañas con mal rendimiento"
❌ Mezclar causas: un CPL alto tiene UNA causa principal, identifícala
❌ Ignorar la descomposición: el CPL es un RESULTADO, no una causa
❌ Omitir variaciones: siempre mostrar cambio % vs período anterior`;
}

// ─── TOOL DEFINITIONS ───────────────────────────────────────────────────────
const customTools = [
  {
    name: 'run_bigquery_query',
    description:
      'Execute a SQL query against BigQuery to get campaign performance data. ALWAYS use this tool before answering data questions. Returns rows as JSON.',
    input_schema: {
      type: 'object',
      properties: {
        sql: {
          type: 'string',
          description:
            'GoogleSQL query. Use backtick-quoted table references: `perfomance-490910.uandes_marketing.table_name`',
        },
        purpose: {
          type: 'string',
          description: 'Brief description of what this query will answer',
        },
      },
      required: ['sql', 'purpose'],
    },
  },
];

// Web search is a built-in Anthropic tool with its own format
const webSearchTool = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: MAX_WEB_SEARCHES,
};

// ─── MAIN HANDLER ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const startTime = Date.now();

  try {
    const { messages: userMessages } = req.body;
    if (!userMessages || !Array.isArray(userMessages) || userMessages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    // Limit history to last 4 messages
    const recentMessages = userMessages.slice(-4).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const systemPrompt = buildSystemPrompt();

    // Tool-use loop
    let messages = [...recentMessages];
    let finalText = '';
    let webSearchCount = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // Guard against Vercel timeout (60s) - leave 5s buffer
      const elapsed = Date.now() - startTime;
      if (elapsed > 55000) {
        console.warn(`[Round ${round + 1}] Approaching timeout (${elapsed}ms elapsed). Breaking with current text.`);
        break;
      }
      
      console.log(`[Round ${round + 1}] Starting. Elapsed: ${elapsed}ms`);
      
      // Build tool_choice: force BigQuery on round 1
      let tool_choice = undefined;
      if (round === 0) {
        tool_choice = { type: 'tool', name: 'run_bigquery_query' };
      }

      // Build tools array: custom + web search (if not exhausted)
      const availableTools = [...customTools];
      if (webSearchCount < MAX_WEB_SEARCHES) {
        availableTools.push(webSearchTool);
      }

      const body = {
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
        tools: availableTools,
      };
      if (tool_choice) body.tool_choice = tool_choice;

      let response;
      try {
        response = await callClaude(body);
      } catch (err) {
        console.error(`[Round ${round + 1}] Claude API error: ${err.message} (status: ${err.status})`);
        // Retry once on 529
        if (err.status === 529) {
          await sleep(3000);
          response = await callClaude(body);
        } else {
          throw err;
        }
      }

      const { content, stop_reason } = response;
      
      // Log what Claude returned
      const blockTypes = content.map(b => b.type).join(', ');
      console.log(`[Round ${round + 1}] Claude returned: [${blockTypes}] stop_reason=${stop_reason}. Elapsed: ${Date.now() - startTime}ms`);

      // Extract text blocks from this round
      const textBlocks = content.filter((b) => b.type === 'text').map((b) => b.text);
      if (textBlocks.length > 0) {
        finalText = textBlocks.join('\n');
        console.log(`[Round ${round + 1}] Got text: ${finalText.length} chars`);
      }

      // Check for tool use
      const toolUseBlocks = content.filter((b) => b.type === 'tool_use');

      // If no tool calls, we're done — Claude gave a final text response
      if (toolUseBlocks.length === 0) {
        console.log(`[Round ${round + 1}] No tool calls, breaking.`);
        break;
      }

      // If stop_reason is end_turn but there ARE tool blocks,
      // we still need to process them (Claude sometimes mixes text + tool_use)
      // But if stop_reason is end_turn with no tool_use, we already broke above.

      // Process tool calls
      messages.push({ role: 'assistant', content });

      const toolResults = [];
      for (const toolCall of toolUseBlocks) {
        let result;

        if (toolCall.name === 'run_bigquery_query') {
          try {
            console.log(`[BQ Round ${round + 1}] ${toolCall.input.purpose || 'query'}`);
            const bqResult = await runBigQuery(toolCall.input.sql);
            result = JSON.stringify(bqResult);
          } catch (err) {
            console.error(`[BQ Error] ${err.message}`);
            result = JSON.stringify({ error: err.message });
          }
        } else {
          result = JSON.stringify({ error: `Unknown tool: ${toolCall.name}` });
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolCall.id,
          content: result,
        });
      }

      if (toolResults.length > 0) {
        messages.push({ role: 'user', content: toolResults });
      }

      // If this was end_turn, don't do another round
      if (stop_reason === 'end_turn') {
        break;
      }
    }

    const responseTime = Date.now() - startTime;

    // Fallback if no text was generated
    if (!finalText || finalText.trim() === '') {
      console.error(`[Chat] No text generated after ${MAX_TOOL_ROUNDS} rounds. Response time: ${responseTime}ms`);
      finalText = 'Error: No se pudo generar una respuesta. Por favor intenta de nuevo.';
    }

    console.log(`[Chat] Response generated in ${responseTime}ms, length: ${finalText.length}`);

    // Return JSON response
    return res.status(200).json({
      response: finalText,
      response_time_ms: responseTime,
    });
  } catch (err) {
    console.error('Chat error:', err);
    const status = err.status || 500;
    return res.status(status).json({
      error: err.message || 'Internal server error',
      response_time_ms: Date.now() - startTime,
    });
  }
}

// ─── Claude API Call ────────────────────────────────────────────────────────
async function callClaude(body) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const err = new Error(`Claude API error: ${resp.status}`);
    err.status = resp.status;
    try {
      const errBody = await resp.json();
      err.message = errBody.error?.message || err.message;
    } catch {}
    throw err;
  }

  return resp.json();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
