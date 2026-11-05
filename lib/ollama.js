'use strict';

const { SYSTEM_PROMPT, buildUserContent } = require('./prompt');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
// This app targets weak local CPUs — allow generous time for slow inference.
const TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 30 * 60 * 1000;

/** Check if the Ollama server is reachable. */
async function status() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/version`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { running: false, error: `HTTP ${res.status}` };
    const data = await res.json();
    return { running: true, version: data.version || 'unknown' };
  } catch (err) {
    return { running: false, error: err.message };
  }
}

/** List installed models. */
async function listModels() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      family: m.details?.family || null,
      quant: m.details?.quantization_level || null,
    }));
  } catch {
    return [];
  }
}

/**
 * Organize meeting notes, streaming progress.
 * @param {string} model
 * @param {string} notes
 * @param {object} meta {title,date,attendees}
 * @param {(info:{tokens:number,seconds:number})=>void} onProgress
 * @returns {Promise<string>} raw JSON text from the model
 */
async function extractStream(model, notes, meta, onProgress) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      model,
      stream: true,
      format: 'json',
      options: { temperature: 0.2, num_predict: 550 },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserContent(notes, meta) },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama returned ${res.status}: ${body.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let tokens = 0;
  let promptReported = false;
  const started = Date.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let chunk;
      try {
        chunk = JSON.parse(line);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error);
      if (!promptReported && chunk.prompt_eval_count) {
        promptReported = true;
        onProgress &&
          onProgress({
            tokens: 0,
            seconds: (Date.now() - started) / 1000,
            promptTokens: chunk.prompt_eval_count,
            phase: 'prompt',
          });
      }
      if (chunk.message?.content) {
        content += chunk.message.content;
        tokens += 1; // ~1 chunk per generated token
        if (onProgress && tokens % 5 === 0) {
          onProgress({ tokens, seconds: (Date.now() - started) / 1000, phase: 'generate' });
        }
      }
    }
  }

  if (onProgress) onProgress({ tokens, seconds: (Date.now() - started) / 1000, phase: 'generate' });
  if (!content) throw new Error('Ollama returned an empty response');
  return content;
}

module.exports = { status, listModels, extractStream, OLLAMA_URL };
