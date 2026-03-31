// api/chat.js — UAndes Analytics Chat (Hybrid: Vercel BQ + Supabase Claude)
import jwt from 'jsonwebtoken';

export const config = { maxDuration: 60 };

const BQ_PROJECT = 'perfomance-490910';
const BQ_DATASET = 'uandes_marketing';
const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
const SUPABASE_FN = 'https://qogtgpqaqaouxhfckzsq.supabase.co/functions/v1/analyze';

let cachedToken = null;
let tokenExpiry = 0;

async function getBQToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;
  const sa = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
  const now = Math.floor(Date.now() / 1000);
  const token = jwt.sign({
    iss: sa.client_email, sub: sa.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/bigquery.readonly',
  }, sa.private_key, { algorithm: 'RS256' });
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${token}`,
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('BQ auth failed');
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function runBigQuery(sql) {
  const token = await getBQToken();
  const resp = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_PROJECT}/queries`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql, useLegacySql: false, maxResults: 100, timeoutMs: 30000 }),
    }
  );
  const data = await resp.json();
  if (data.error) return `Error: ${data.error.message || JSON.stringify(data.error)}`;
  if (!data.jobComplete) return 'Error: Query timeout';
  if (!data.rows || data.rows.length === 0) return '0 rows returned.';
  const fields = (data.schema?.fields || []).map((f) => f.name);
  const rows = data.rows.map((r) => fields.map((f, i) => r.f[i]?.v ?? 'NULL').join(' | '));
  let out = fields.join(' | ') + '\n' + rows.slice(0, 30).join('\n');
  if (out.length > 10000) out = out.slice(0, 10000) + '\n...(truncated)';
  return data.totalRows + ' rows.\n' + out;
}

function sysPrompt() {
  const today = new Date().toISOString().split('T')[0];
  return `Analista performance digital UAndes Online. Hoy: ${today}.
Analisis CAUSAL y OPERATIVO. Datos exactos, nunca frases genericas.
CPL decomp: CPC=SUBASTA, CTR=CREATIVIDAD, CPM=COMPETENCIA, Freq=FATIGA(>3=alerta), CVR=LANDING.
TC(matriculados/mqls*100), CAC(spend/matriculados), ROAS(revenue/spend). JOIN campaign_id con stg_hubspot_deals_attributed.extracted_campaign_id, usar amount_in_company_currency.
Plataforma obligatoria. Links: Google=[Ver](https://ads.google.com/aw/campaigns?campaignId={id}&ocid=4804138296) Meta=[Ver](https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=598016410984327&selected_campaign_ids={id}). campaign_id en queries.
Si N campanas, tabla top 5-8 + resumen completo N.
BQ: \`${BQ_PROJECT}.${BQ_DATASET}.tabla\`. rpt_campaign_performance_daily: date,platform('Meta'|'Google'),campaign_id,campaign_name,diplomado,negocio,spend_with_iva,impressions,clicks,reach,leads,mqls.
Negocios: Medicina Nuevos,Medicina Antiguos,Enfermeria,Derecho,Educacion,ICOM,ICF,ADS Medicina/Gestion ADS,ADS Educacion,CET/Gestion Inmobiliaria,UDEP (Peru),Magister,Odontologia.
stg_hubspot_deals_attributed,FBADS_AD,GOOGLEADS_KEYWORD,GOOGLEADS_SEARCH_QUERY disponibles.
SQL: backticks, NULLIF, platform mayuscula, periodo anterior CTEs, campaign_id en SELECT. UNA query. Espanol.`;
}

const bqTool = {
  name: 'run_bigquery_query',
  description: 'Execute SQL against BigQuery.',
  input_schema: { type: 'object', properties: { sql: { type: 'string' }, purpose: { type: 'string' } }, required: ['sql'] },
};

async function callClaude(body) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const err = new Error(`Claude ${resp.status}`);
    err.status = resp.status;
    try { const e = await resp.json(); err.message = e.error?.message || err.message; } catch {}
    throw err;
  }
  return resp.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const t0 = Date.now();
  try {
    const { messages: um } = req.body;
    if (!um?.length) return res.status(400).json({ error: 'messages required' });

    const userQ = um[um.length - 1]?.content || '';
    const msgs = um.slice(-4).map((m) => ({
      role: m.role, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));

    // STEP 1: Claude generates SQL (~5s)
    console.log('[S1] SQL gen...');
    const r1 = await callClaude({
      model: CLAUDE_MODEL, max_tokens: 1024, system: sysPrompt(),
      messages: msgs, tools: [bqTool],
      tool_choice: { type: 'tool', name: 'run_bigquery_query' },
    });
    const tb = r1.content.find((b) => b.type === 'tool_use');
    if (!tb) return res.status(200).json({ response: 'No se pudo generar consulta.', response_time_ms: Date.now() - t0 });
    console.log(`[S1] Done ${Date.now()-t0}ms`);

    // STEP 2: Execute BQ (~3s) - works in Vercel
    console.log('[S2] BQ...');
    let bqData;
    try { bqData = await runBigQuery(tb.input.sql); } catch (e) { bqData = 'Error: ' + e.message; }
    console.log(`[S2] Done ${Date.now()-t0}ms len=${bqData.length}`);

    // STEP 3: Send to Supabase Edge Function for Claude analysis (150s timeout!)
    console.log('[S3] Supabase analyze...');
    const aResp = await fetch(SUPABASE_FN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: userQ, bqData }),
    });
    const aData = await aResp.json();
    console.log(`[S3] Done ${Date.now()-t0}ms`);

    return res.status(200).json({
      response: aData.response || aData.error || 'Sin respuesta.',
      response_time_ms: Date.now() - t0,
    });
  } catch (err) {
    console.error('Error:', err.message);
    return res.status(err.status || 500).json({ error: err.message, response_time_ms: Date.now() - t0 });
  }
}
