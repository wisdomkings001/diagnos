/**
 * newsSignal.js — LLM news/event layer for the diagnostic engine.
 *
 * A fourth signal alongside trend/volatility/sentiment: reads news/event
 * context via LLM and returns a directional bias or an event-risk veto.
 * Qwen is primary, Groq is fallback — unattended paper-trading for days
 * can't have the LLM layer as a single point of failure, so if Qwen is
 * slow or down, this fails over to Groq and logs which provider answered.
 *
 * Env (Railway -> Variables):
 *   QWEN_API_KEY    - hackathon credits key for https://hackathon.bitgetops.com/v1
 *   QWEN_BASE_URL   - default https://hackathon.bitgetops.com/v1 (override if doc changes)
 *   QWEN_MODEL      - default qwen3-max (override with exact model from hackathon doc)
 *   GROQ_API_KEY    - from https://console.groq.com/keys (free tier, no KYC)
 *   GROQ_MODEL      - default llama-3.3-70b-versatile
 *
 * No dependencies. Node 18+ (uses built-in fetch). No real funds involved.
 */

const QWEN_BASE_URL = (process.env.QWEN_BASE_URL || 'https://hackathon.bitgetops.com/v1').replace(/\/$/, '');
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3-max';
const QWEN_API_KEY = process.env.QWEN_API_KEY || null;

const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const GROQ_API_KEY = process.env.GROQ_API_KEY || null;

const LLM_TIMEOUT_MS = 20000;
const MAX_HEADLINES = 8;

function buildNewsPrompt(pair, headlines) {
  const clean = (headlines || []).filter(Boolean).slice(0, MAX_HEADLINES);
  const list = clean.length
    ? clean.map((h, i) => `${i + 1}. ${String(h).slice(0, 300)}`).join('\n')
    : '(no headlines available for this cycle)';

  return (
    `You are a cautious crypto event-risk analyst for a paper-trading diagnostic agent.\n` +
    `Asset: ${pair} (perpetual futures, USDT-margined).\n` +
    `Recent headlines/events:\n${list}\n\n` +
    `Task: judge near-term (24-48h) directional bias from NEWS ONLY, not price action.\n` +
    `Respond with STRICT JSON, no other text, in exactly this shape:\n` +
    `{"bias":"bullish"|"bearish"|"neutral","confidence":0-100,"eventRisk":true|false,"reason":"one sentence, max 25 words"}\n` +
    `Rules:\n` +
    `- confidence < 60 or no real news -> bias "neutral", confidence <= 50.\n` +
    `- eventRisk true ONLY for hard near-term uncertainty: earnings/macro decision/hack/ETF ruling/major listing-delisting within 48h.\n` +
    `- Never invent events. If headlines are empty or irrelevant, return neutral with low confidence.`
  );
}

async function callOpenAICompatible({ baseUrl, apiKey, model, prompt, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || LLM_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 250,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      throw new Error(`LLM HTTP ${res.status}: ${body}`);
    }
    const json = await res.json();
    const text = json.choices && json.choices[0] && json.choices[0].message
      ? json.choices[0].message.content
      : '';
    if (!text) throw new Error('Empty LLM response');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function parseLLMResponse(text) {
  // Tolerant: extract first {...} block, then JSON.parse.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM did not return JSON');
  const obj = JSON.parse(text.slice(start, end + 1));

  const bias = ['bullish', 'bearish', 'neutral'].includes(String(obj.bias).toLowerCase())
    ? String(obj.bias).toLowerCase()
    : 'neutral';
  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) confidence = 0;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  return {
    bias,
    confidence,
    eventRisk: obj.eventRisk === true,
    reason: String(obj.reason || 'no reason given').slice(0, 200),
  };
}

function llmToSignal(parsed) {
  // Map to the same -100..+100 scale as trend/sentiment so runDiagnostic
  // can treat it symmetrically.
  // Low confidence (<60) -> 0 regardless of bias. This is deliberate:
  // the LLM only moves the needle when it is actually sure.
  if (parsed.bias === 'neutral' || parsed.confidence < 60) {
    return { value: 0, veto: parsed.eventRisk === true };
  }
  const magnitude = Math.round((parsed.confidence / 100) * 60); // cap at 60, same weight as sentiment extremes
  return {
    value: parsed.bias === 'bullish' ? magnitude : -magnitude,
    veto: parsed.eventRisk === true,
  };
}

function neutralResult(pair, label, extra) {
  return {
    pair,
    value: 0,
    bias: 'neutral',
    confidence: 0,
    veto: false,
    provider: 'none',
    label,
    ...(extra || {}),
  };
}

/**
 * newsSignal(pair, headlines) -> Promise<NewsSignal>
 * Never throws: on any failure returns a neutral no-op signal so the
 * trading cycle continues on rule-based logic alone.
 */
async function newsSignal(pair, headlines) {
  const prompt = buildNewsPrompt(pair, headlines);

  // 1. Qwen primary
  if (QWEN_API_KEY) {
    try {
      const text = await callOpenAICompatible({
        baseUrl: QWEN_BASE_URL,
        apiKey: QWEN_API_KEY,
        model: QWEN_MODEL,
        prompt,
      });
      const parsed = parseLLMResponse(text);
      const sig = llmToSignal(parsed);
      return {
        pair,
        value: sig.value,
        bias: parsed.bias,
        confidence: parsed.confidence,
        veto: sig.veto,
        provider: 'qwen',
        label: `news ${parsed.bias} ${parsed.confidence}/100 via qwen — ${parsed.reason}`,
      };
    } catch (err) {
      console.warn(`newsSignal ${pair}: Qwen failed (${err.message}), trying Groq fallback.`);
    }
  } else {
    console.warn(`newsSignal ${pair}: QWEN_API_KEY unset, skipping to Groq fallback.`);
  }

  // 2. Groq fallback
  if (GROQ_API_KEY) {
    try {
      const text = await callOpenAICompatible({
        baseUrl: GROQ_BASE_URL,
        apiKey: GROQ_API_KEY,
        model: GROQ_MODEL,
        prompt,
      });
      const parsed = parseLLMResponse(text);
      const sig = llmToSignal(parsed);
      return {
        pair,
        value: sig.value,
        bias: parsed.bias,
        confidence: parsed.confidence,
        veto: sig.veto,
        provider: 'groq',
        label: `news ${parsed.bias} ${parsed.confidence}/100 via groq — ${parsed.reason}`,
      };
    } catch (err) {
      console.warn(`newsSignal ${pair}: Groq fallback also failed (${err.message}). Continuing neutral.`);
      return neutralResult(pair, 'news unavailable (both providers failed) — continuing on rule-based signals only');
    }
  }

  return neutralResult(pair, 'news skipped (no LLM keys set) — continuing on rule-based signals only');
}

// Veto forces FAULT (close/reduce path). Non-zero bias nudges conviction
// by at most +/-20 points, never enough alone to flip FAULT->DIAGNOSED.
function mergeNewsIntoDiagnostic(diagnostic, news, thresholds) {
  const faultAt = (thresholds && thresholds.fault) || 30;
  const diagnosedAt = (thresholds && thresholds.diagnosed) || 70;
  if (!news) return diagnostic;
  if (news.veto === true) {
    return {
      ...diagnostic,
      state: 'FAULT',
      convictionScore: Math.min(diagnostic.convictionScore, 20),
      reason: `${diagnostic.reason} LLM event-risk veto (${news.provider}): ${news.label}.`,
      news,
    };
  }
  if (news.value !== 0) {
    const adjusted = Math.max(0, Math.min(100, diagnostic.convictionScore + Math.round(news.value / 3)));
    const state = adjusted < faultAt ? 'FAULT' : adjusted < diagnosedAt ? 'INCONCLUSIVE' : 'DIAGNOSED';
    return {
      ...diagnostic,
      convictionScore: adjusted,
      state,
      reason: `${diagnostic.reason} News layer (${news.provider}): ${news.label}.`,
      news,
    };
  }
  return { ...diagnostic, news };
}

module.exports = {
  newsSignal,
  mergeNewsIntoDiagnostic,
  callOpenAICompatible,
  providers: {
    qwen: { baseUrl: QWEN_BASE_URL, apiKey: QWEN_API_KEY, model: QWEN_MODEL },
    groq: { baseUrl: GROQ_BASE_URL, apiKey: GROQ_API_KEY, model: GROQ_MODEL },
  },
  // exported for unit testing only
  _internals: { buildNewsPrompt, parseLLMResponse, llmToSignal },
};
