// api/chat.js — UAndes Analytics Chat (Vercel Serverless Function)
// Stack: Claude API (tool-use), BigQuery, ESM
// Produces CAUSAL and OPERATIVE analysis, not descriptive.

import jwt from 'jsonwebtoken';

export const config = { maxDuration: 60 };

// ─── CONSTANTS ──────────────────────────────────────────────────────────────
const BQ_PROJECT = 'perfomance-490910';
const BQ_DATASET = 'uandes_marketing';
const MAX_BQ_ROWS = 50;
const MAX_BQ_BYTES = 15000;
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
  if (data.error) return `Error: ${data.error.message || JSON.stringify(data.error)}`;
  if (!data.jobComplete) return 'Error: Query timeout after 30s';

  const fields = (data.schema?.fields || []).map((f) => f.name);
  const rows = (data.rows || []).map((r) =>
    Object.fromEntries(fields.map((f, i) => [f, r.f[i].v]))
  );

  let result = rows.slice(0, MAX_BQ_ROWS);

  const header = fields.join(' | ');
  const dataRows = result.map((r) => fields.map((f) => r[f] ?? 'NULL').join(' | '));
  let textResult = `${header}\n${dataRows.join('\n')}`;

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
4. Responder en español
5. Después de recibir los datos, responder INMEDIATAMENTE con el análisis. NO pedir más datos.

## NUNCA
❌ Frases vagas ❌ Sin datos ❌ Acciones genéricas ❌ Omitir plataforma ❌ Omitir campañas ❌ Ignorar TC/CAC en ventas ❌ Hacer múltiples queries secuenciales (usar CTEs)`;
}

// ─── TOOL DEFINITIONS ───────────────────────────────────────────────────────
const customTools = [
  {
    name: 'run_bigquery_query',
    description:
      'Execute a SQL query against BigQuery to get campaign performance data. ALWAYS use this tool before answering data questions. Returns rows as text.',
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

// ─── MAIN HANDLER ───────────────────────────────────────────────────────────
export default async function handler(req, res) {
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

    const recentMessages = userMessages.slice(-4).map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    const systemPrompt = buildSystemPrompt();
    let messages = [...recentMessages];
    let finalText = '';

    // ─── ROUND 1: Force BigQuery query ───────────────────────
    console.log(`[Round 1] Starting. Elapsed: ${Date.now() - startTime}ms`);

    const round1Body = {
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools: customTools,
      tool_choice: { type: 'tool', name: 'run_bigquery_query' },
    };

    let round1Response;
    try {
      round1Response = await callClaude(round1Body);
    } catch (err) {
      if (err.status === 529) {
        await sleep(3000);
        round1Response = await callClaude(round1Body);
      } else {
        throw err;
      }
    }

    const toolUseBlock = round1Response.content.find((b) => b.type === 'tool_use');
    if (!toolUseBlock) {
      finalText = round1Response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n') || 'No se pudo generar la consulta. Intenta de nuevo.';
    } else {
      let bqResult;
      try {
        console.log(`[BQ] ${toolUseBlock.input.purpose || 'query'}`);
        bqResult = await runBigQuery(toolUseBlock.input.sql);
      } catch (err) {
        console.error(`[BQ Error] ${err.message}`);
        bqResult = `Error: ${err.message}`;
      }

      console.log(`[Round 1] BQ done. Elapsed: ${Date.now() - startTime}ms`);

      // ─── ROUND 2: Get text response with data (NO tools) ───
      messages.push({ role: 'assistant', content: round1Response.content });
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseBlock.id,
            content: String(bqResult),
          },
        ],
      });

      console.log(`[Round 2] Starting. Elapsed: ${Date.now() - startTime}ms`);

      const round2Body = {
        model: CLAUDE_MODEL,
        max_tokens: MAX_TOKENS,
        system: systemPrompt,
        messages,
      };

      let round2Response;
      try {
        round2Response = await callClaude(round2Body);
      } catch (err) {
        if (err.status === 529) {
          await sleep(3000);
          round2Response = await callClaude(round2Body);
        } else {
          throw err;
        }
      }

      const textBlocks = round2Response.content.filter((b) => b.type === 'text');
      finalText = textBlocks.map((b) => b.text).join('\n');

      console.log(`[Round 2] Done. Text: ${finalText.length} chars. Elapsed: ${Date.now() - startTime}ms`);
    }

    const responseTime = Date.now() - startTime;

    if (!finalText || finalText.trim() === '') {
      console.error(`[Chat] No text generated. Response time: ${responseTime}ms`);
      finalText = 'Error: No se pudo generar una respuesta. Por favor intenta de nuevo.';
    }

    console.log(`[Chat] Response generated in ${responseTime}ms, length: ${finalText.length}`);

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
