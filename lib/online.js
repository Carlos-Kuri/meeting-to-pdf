'use strict';

const { SYSTEM_PROMPT, buildUserContent } = require('./prompt');

// Online requests normally finish in seconds; 5 min is a generous safety cap.
const ONLINE_TIMEOUT_MS = Number(process.env.ONLINE_TIMEOUT_MS) || 5 * 60 * 1000;

/**
 * Registry of supported AI sources.
 * All online providers speak the OpenAI chat-completions protocol,
 * so one client covers every one of them.
 */
const PROVIDERS = [
  {
    id: 'pollinations',
    label: 'Free online — no sign-up (Pollinations)',
    shortLabel: 'Free online',
    needsKey: false,
    baseUrl: 'https://text.pollinations.ai/openai',
    modelsUrl: 'https://text.pollinations.ai/models',
    listFormat: 'pollinations',
    defaultModel: 'openai-fast',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter — free models (free API key)',
    shortLabel: 'OpenRouter',
    needsKey: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    listFormat: 'openai-free',
  },
  {
    id: 'groq',
    label: 'Groq — free tier (free API key)',
    shortLabel: 'Groq',
    needsKey: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    modelsUrl: 'https://api.groq.com/openai/v1/models',
    listFormat: 'groq',
  },
  {
    id: 'gemini',
    label: 'Google Gemini — free tier (free API key)',
    shortLabel: 'Gemini',
    needsKey: true,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
    listFormat: 'openai',
    fallbackModels: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  },
  {
    id: 'ollama',
    label: 'Local model (Ollama)',
    shortLabel: 'Local (Ollama)',
    needsKey: false,
    local: true,
  },
  {
    id: 'custom',
    label: 'Custom — any OpenAI-compatible server',
    shortLabel: 'Custom',
    needsKey: false,
    askBaseUrl: true,
    modelsUrl: null, // uses baseUrl + /models
    listFormat: 'openai',
    fallbackModels: [],
  },
];

function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

// Models that cannot answer meeting-notes prompts (speech/vision helpers etc.)
const NON_CHAT_RE = /whisper|tts|stt|audio|embedding|guard|prompt-cache|embeddinggemma/i;

/**
 * Fetch the available model list for an online provider.
 * @returns {Promise<{models: string[], error?: string}>}
 */
async function listOnlineModels(provider, { apiKey, baseUrl } = {}) {
  const base = baseUrl || provider.baseUrl;
  if (provider.id === 'custom' && !base) {
    return { models: [], error: 'No base URL configured.' };
  }

  let url;
  if (provider.id === 'pollinations') url = provider.modelsUrl;
  else if (provider.id === 'custom') url = base.replace(/\/+$/, '') + '/models';
  else url = provider.modelsUrl || base.replace(/\/+$/, '') + '/models';

  try {
    const headers = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(body);
        msg = j.error?.message || j.message || msg;
      } catch { /* keep raw */ }
      return { models: provider.fallbackModels || [], error: res.status === 401 ? `Invalid API key (${msg})` : msg };
    }
    const data = await res.json();
    let models = [];

    if (provider.listFormat === 'pollinations') {
      models = (Array.isArray(data) ? data : [])
        .filter((m) => (m.tier || 'anonymous') === 'anonymous' || m.tier === 'registered' || !m.tier)
        .map((m) => m.name)
        .filter(Boolean);
    } else {
      const list = Array.isArray(data) ? data : data.data || [];
      models = list.map((m) => m.id || m.name).filter(Boolean);
      if (provider.listFormat === 'openai-free') models = models.filter((id) => id.endsWith(':free'));
      else if (provider.listFormat === 'groq') models = models.filter((id) => !NON_CHAT_RE.test(id));
    }

    if (!models.length) models = provider.fallbackModels || [];
    return { models };
  } catch (err) {
    return { models: provider.fallbackModels || [], error: err.message };
  }
}

/**
 * Organize meeting notes with an online OpenAI-compatible model, streaming progress.
 * @param {object} opts
 * @param {object} opts.provider   registry entry
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseUrl]  custom providers
 * @param {string} opts.notes
 * @param {object} opts.meta       {title,date,attendees}
 * @param {(info:{tokens:number,seconds:number,phase:string})=>void} [opts.onProgress]
 * @returns {Promise<string>} raw text from the model
 */
async function extractOnline({ provider, model, apiKey, baseUrl, notes, meta, onProgress }) {
  const base = (baseUrl || provider.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('Missing base URL for this provider.');
  if (provider.needsKey && !apiKey) throw new Error(`API key required for ${provider.shortLabel}.`);

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(ONLINE_TIMEOUT_MS),
    body: JSON.stringify({
      model,
      stream: true,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(notes, meta) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(body);
      msg = j.error?.message || j.message || msg;
    } catch { /* keep raw */ }
    throw new Error(`${provider.shortLabel}: ${msg}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let tokens = 0;
  const started = Date.now();

  const report = (phase) => {
    if (onProgress && tokens > 0) onProgress({ tokens, seconds: (Date.now() - started) / 1000, phase });
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;

      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message || String(chunk.error));

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // Reasoning models think first — count it so users see progress.
      if (delta.reasoning || delta.reasoning_content) {
        tokens += 1;
        report('think');
      }
      if (delta.content) {
        content += delta.content;
        tokens += 1;
        if (tokens % 5 === 0) report('generate');
      }
    }
  }

  report('generate');
  if (!content.trim()) throw new Error(`${provider.shortLabel} returned an empty response.`);
  return content;
}

module.exports = { PROVIDERS, getProvider, listOnlineModels, extractOnline };
