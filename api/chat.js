// api/chat.js — UAndes Analytics Chat (Vercel Serverless Function)
// Stack: Claude API (tool-use + web search), BigQuery, ESM
// Produces CAUSAL and OPERATIVE analysis, not descriptive.

import jwt from 'jsonwebtoken';

export const config = { maxDuration: 60 };

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const BQ_PROJECT = 'perfomance-490910';
const BQ_DATASET = 'uandes_marketing';
const MAX_TOOL_ROUNDS = 3;
const MAX_BQ_ROWS = 50;
const MAX_BQ_BYTES = 15000;
const MAX_WEB_SEARCHES = 2;
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 3000;

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

  // Truncate rows
  let result = rows.slice(0, MAX_BQ_ROWS);

  // Format as compact text table (much smaller than JSON, no [object Object] issues)
  const header = fields.join(' | ');
  const dataRows = result.map((r) => fields.map((f) => r[f] ?? 'NULL').join(' | '));
  let textResult = `${header}\n${dataRows.join('\n')}`;

  // Truncate by bytes if needed
  if (textResult.length > MAX_BQ_BYTES) {
    const lines = textResult.split('\n');
    while (lines.length > 2 && lines.join('\n').length > MAX_BQ_BYTES) {
      lines.pop();
    }
    textResult = lines.join('\n');
  }

  return `${data.totalRows} rows total, showing ${result.length}.\n${textResult}`;
}

// ─── TODAY helper ───────────────────────────────────────────────────────────
function getToday() {
  return new Date().toISOString().split('T')[0];
}

// ─── SYSTEM PROMPT ──────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const today = getToday();
  return `Analista de performance digital UAndes Online. Hoy: ${today}.

## PRINCIPIOS
Análisis CAUSAL y OPERATIVO, nunca descriptivo. Identificar QUÉ pasa, POR QUÉ (causa raíz), QUÉ HACER (acción concreta).
NUNCA frases genéricas ("alta competencia", "saturación"). SIEMPRE datos exactos.

## DESCOMPOSICIÓN CPL (obligatoria)
| Métrica | Fórmula | Diagnostica |
|---------|---------|-------------|
| CPC | spend/clicks | SUBASTA |
| CTR | clicks/imp×100 | CREATIVIDAD |
| CPM | (spend/imp)×1000 | COMPETENCIA |
| Freq | imp/reach | FATIGA (>3=alerta) |
| CVR | leads/clicks×100 | LANDING PAGE |
| MQL Rate | mqls/leads×100 | CALIFICACIÓN |

## MÉTRICAS DE NEGOCIO (para ventas/metas/rendimiento)
| Métrica | Fórmula | Mide |
|---------|---------|------|
| TC | matriculados/mqls×100 | Eficiencia comercial |
| CAC | spend/matriculados | Costo adquisición |
| ROAS | revenue/spend | Retorno inversión |

Para TC/CAC: cruzar rpt_campaign_performance_daily.campaign_id con stg_hubspot_deals_attributed.extracted_campaign_id. Usar amount_in_company_currency (NO amount) para revenue en CLP. UDEP tiene montos PEN mal etiquetados como CLP.

## REGLAS DE OUTPUT
- Columna "Plataforma" obligatoria en TODA tabla
- En texto: siempre "(Meta)" o "(Google)" tras nombre campaña
- Primera vez que uses sigla, definir: CPC=Costo Por Click, CTR=Click-Through Rate, CVR=Tasa Conversión a Lead, TC=Tasa Conversión comercial, CAC=Costo Adquisición, ROAS=Return on Ad Spend
- COMPLETITUD: Si dices "N campañas", mostrar tabla detallada top 5-8 + tabla resumen COMPLETA de las N con: Campaña|Plataforma|Gasto|CPL|Diagnóstico|Link
- Links: Google=[Ver](https://ads.google.com/aw/campaigns?campaignId={id}&ocid=4804138296) Meta=[Ver](https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=598016410984327&selected_campaign_ids={id})
- SIEMPRE incluir campaign_id en queries para generar links
- Severidad: 🔴 crítico, 🟡 atención, 🟢 OK

## DIAGNÓSTICO CAUSAL
CPL↑+CPC↑+CTR estable→SUBASTA | CPL↑+CTR↓→CREATIVIDAD | CPL↑+CVR↓→LANDING | Freq>3→FATIGA | CPM↑→COMPETENCIA

## ACCIONES: campaña específica + condición + verbo imperativo + motivo + prioridad

## BigQuery
Proyecto: \`${BQ_PROJECT}\`, Dataset: \`${BQ_DATASET}\`

### rpt_campaign_performance_daily (principal)
date(DATE), platform('Meta'|'Google'), campaign_id, campaign_name, diplomado, negocio, spend_with_iva(FLOAT64), impressions(INT64), clicks(INT64), reach(INT64), leads(INT64), mqls(INT64), cpl_with_iva, cpl_status
Negocios: Medicina Nuevos, Medicina Antiguos, Enfermería, Derecho, Educación, ICOM, ICF, ADS Medicina/Gestion ADS, ADS Educación, CET/Gestion Inmobiliaria, UDEP (Peru), Magister, Odontologia (+NULL)

### stg_hubspot_deals_attributed (deals/matriculados)
extracted_campaign_id(JOIN key), amount_in_company_currency(CLP normalizado), detected_platform, diplomado, diplomado_negocio, close_date_only(DATE)

### FBADS_AD: DATE, CAMPAIGN_NAME, COST, CLICKS, IMPRESSIONS, REACH, LANDING_PAGE_VIEWS, OFFSITE_CONVERSIONS_FB_PIXEL_LEAD
### GOOGLEADS_KEYWORD: DATE, CAMPAIGN_NAME, KEYWORD, MATCH_TYPE, QUALITY_SCORE, CLICKS, IMPRESSIONS, COST
### GOOGLEADS_SEARCH_QUERY: DATE, CAMPAIGN_NAME, SEARCH_TERM, CLICKS, IMPRESSIONS, CONVERSIONS, COST

## SQL: backticks \`${BQ_PROJECT}.${BQ_DATASET}.tabla\`, NULLIF divisiones, platform con mayúscula, SIEMPRE período anterior para variaciones, SIEMPRE campaign_id en SELECT

## HERRAMIENTAS
1. SIEMPRE ejecutar BigQuery antes de responder
2. **CRÍTICO: Hacer UNA SOLA query que traiga TODA la data necesaria (periodo actual + anterior en la misma query con CTEs). NUNCA hacer queries secuenciales. Tienes max 60s total.**
3. Preguntas ventas/metas/TC/CAC → query funnel con stg_hubspot_deals_attributed
4. Web search solo para contexto mercado. Max ${MAX_WEB_SEARCHES}
5. Responder en español
6. Después de recibir los datos, responder INMEDIATAMENTE con el análisis. NO pedir más datos.

## NUNCA
❌ Frases vagas ❌ Sin datos ❌ Acciones genéricas ❌ Omitir plataforma ❌ Omitir campañas ❌ Ignorar TC/CAC en ventas ❌ Hacer múltiples queries secuenciales (usar CTEs)`;
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
      // Guard against Vercel timeout (60s) - leave 8s buffer
      const elapsed = Date.now() - startTime;
      if (elapsed > 52000) {
        console.warn(`[Round ${round + 1}] Approaching timeout (${elapsed}ms). Breaking.`);
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
            result = await runBigQuery(toolCall.input.sql);
          } catch (err) {
            console.error(`[BQ Error] ${err.message}`);
            result = `Error: ${err.message}`;
          }
        } else {
          result = `Error: Unknown tool ${toolCall.name}`;
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
