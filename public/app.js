'use strict';

const $ = (id) => document.getElementById(id);

let organized = null; // last successful AI result
let providers = []; // provider registry
let currentProvider = null;

// ---------- Storage helpers ----------
const store = {
  get(k, d = '') {
    try { return localStorage.getItem(k) ?? d; } catch { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, v); } catch { /* private mode */ }
  },
};

// ---------- Providers ----------
async function loadProviders() {
  try {
    const res = await fetch('/api/providers');
    const data = await res.json();
    providers = data.providers || [];
  } catch {
    providers = [];
  }

  const sel = $('providerSelect');
  const saved = store.get('mtfp-provider', 'pollinations');
  sel.innerHTML = '';
  providers.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.label;
    sel.appendChild(opt);
  });
  sel.value = providers.some((p) => p.id === saved) ? saved : (providers[0]?.id || '');
  applyProviderUI();
}

function applyProviderUI() {
  currentProvider = providers.find((p) => p.id === $('providerSelect').value) || null;
  if (!currentProvider) return;

  $('keyRow').hidden = !(currentProvider.needsKey || currentProvider.askBaseUrl);
  $('apiKeyRow').hidden = !currentProvider.needsKey;
  $('baseUrlRow').hidden = !currentProvider.askBaseUrl;
  $('statusArea').hidden = !currentProvider.local;

  $('apiKey').value = store.get('mtfp-key-' + currentProvider.id, '');
  $('baseUrl').value = store.get('mtfp-url-' + currentProvider.id, '');

  const hints = {
    pollinations: 'Free, no sign-up — powered by Pollinations. Your notes are sent to their public API.',
    openrouter: 'Free API key: openrouter.ai/keys — models ending in ":free" cost nothing.',
    groq: 'Free API key: console.groq.com/keys — very fast inference.',
    gemini: 'Free API key: aistudio.google.com/apikey — generous free tier.',
    ollama: 'Runs 100% on your machine — slow CPUs can take several minutes per document.',
    custom: 'Any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, …).',
  };
  const hint = $('sourceHint');
  hint.textContent = hints[currentProvider.id] || '';
  hint.hidden = !hint.textContent;
}

async function loadModels() {
  const p = currentProvider;
  if (!p) return;

  const sel = $('modelSelect');
  const input = $('modelInput');
  sel.innerHTML = '';
  $('sourceHint').dataset.err = '';

  try {
    const res = await fetch('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: p.id,
        apiKey: $('apiKey').value.trim() || undefined,
        baseUrl: $('baseUrl').value.trim() || undefined,
      }),
    });
    const data = await res.json();
    let models = data.models || [];

    if (data.error && !models.length) {
      showSourceError(`${data.error}`);
    }

    const saved = store.get('mtfp-model-' + p.id, p.defaultModel || '');

    if (!models.length) {
      // Free-text model entry (e.g. custom servers that don't list models)
      sel.hidden = true;
      input.hidden = false;
      input.value = saved;
      return;
    }

    sel.hidden = false;
    input.hidden = true;
    sel.innerHTML = '';
    models.forEach((m) => {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
    sel.value = models.includes(saved) ? saved
      : (models.includes(p.defaultModel) ? p.defaultModel : models[0]);
  } catch (err) {
    showSourceError('Could not load models: ' + err.message);
  }
}

function showSourceError(msg) {
  const hint = $('sourceHint');
  hint.textContent = msg;
  hint.hidden = false;
  hint.classList.add('hint-error');
}

function currentModel() {
  const input = $('modelInput');
  return input.hidden ? $('modelSelect').value : input.value.trim();
}

// ---------- Local Ollama status ----------
async function checkStatus() {
  if (!currentProvider?.local) return;
  const dot = $('statusDot');
  const text = $('statusText');
  const startBtn = $('startOllamaBtn');

  try {
    const res = await fetch('/api/status');
    const st = await res.json();
    if (st.running) {
      dot.className = 'dot dot-ok';
      text.textContent = `Local AI online (v${st.version})`;
      startBtn.hidden = true;
      if (!currentModel()) loadModels();
    } else {
      dot.className = 'dot dot-down';
      text.textContent = 'Local AI offline';
      startBtn.hidden = false;
    }
  } catch {
    dot.className = 'dot dot-down';
    text.textContent = 'Cannot reach server';
  }
}

$('startOllamaBtn').addEventListener('click', async () => {
  const btn = $('startOllamaBtn');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const res = await fetch('/api/ollama/start', { method: 'POST' });
    const data = await res.json();
    if (!data.ok) showError(data.error || 'Failed to start Ollama');
    else loadModels();
  } catch (err) {
    showError('Failed to start Ollama: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '▶ Start Ollama';
    checkStatus();
  }
});

// ---------- Provider/model wiring ----------
$('providerSelect').addEventListener('change', () => {
  store.set('mtfp-provider', $('providerSelect').value);
  applyProviderUI();
  loadModels();
  checkStatus();
});

$('modelSelect').addEventListener('change', (e) => {
  store.set('mtfp-model-' + currentProvider.id, e.target.value);
});

$('modelInput').addEventListener('input', (e) => {
  store.set('mtfp-model-' + currentProvider.id, e.target.value.trim());
});

$('apiKey').addEventListener('change', () => {
  store.set('mtfp-key-' + currentProvider.id, $('apiKey').value.trim());
  loadModels();
});

$('baseUrl').addEventListener('change', () => {
  store.set('mtfp-url-' + currentProvider.id, $('baseUrl').value.trim());
  loadModels();
});

// ---------- Generate ----------
$('generateBtn').addEventListener('click', generate);
$('clearBtn').addEventListener('click', () => {
  ['title', 'date', 'attendees', 'notes'].forEach((id) => ($(id).value = ''));
  organized = null;
  $('preview').hidden = true;
  $('placeholder').hidden = false;
  $('downloadBtn').hidden = true;
  $('saveFolderBtn').hidden = true;
  $('saveMsg').hidden = true;
  $('savePanel').hidden = true;
  hideError();
});

function showError(msg) {
  const el = $('inputError');
  el.textContent = msg;
  el.hidden = false;
}
function hideError() { $('inputError').hidden = true; }

async function generate() {
  hideError();
  const notes = $('notes').value.trim();
  let model = currentModel();

  // The model list loads asynchronously — retry once if the user was fast
  if (!model) {
    await loadModels();
    model = currentModel();
  }

  if (!notes) return showError('Paste some meeting notes first.');
  if (!model) return showError('Select or enter a model first.');
  if (currentProvider.needsKey && !$('apiKey').value.trim()) {
    return showError(`An API key is required for ${currentProvider.shortLabel}.`);
  }
  if (currentProvider.askBaseUrl && !$('baseUrl').value.trim()) {
    return showError('Enter the base URL for your server.');
  }

  const btn = $('generateBtn');
  btn.disabled = true;
  btn.textContent = 'Working…';
  $('placeholder').hidden = true;
  $('preview').hidden = true;
  $('downloadBtn').hidden = true;
  $('saveFolderBtn').hidden = true;
  $('saveMsg').hidden = true;
  $('savePanel').hidden = true;
  $('spinner').hidden = false;
  $('spinModel').textContent = `${model} (${currentProvider.shortLabel})`;
  $('spinProgress').textContent = 'starting…';
  $('inputHint').textContent = '';

  const meta = {
    title: $('title').value.trim(),
    date: $('date').value.trim(),
    attendees: $('attendees').value.trim(),
  };

  // Local ticker: show elapsed time even while waiting for the first event.
  const startedAt = Date.now();
  let progressSeen = false;
  const ticker = setInterval(() => {
    if (progressSeen) return;
    const s = Math.round((Date.now() - startedAt) / 1000);
    $('spinProgress').textContent = `starting… ${s}s`;
  }, 1000);

  try {
    const res = await fetch('/api/organize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notes,
        model,
        meta,
        provider: currentProvider.id,
        apiKey: $('apiKey').value.trim() || undefined,
        baseUrl: $('baseUrl').value.trim() || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    // Read NDJSON stream: status / progress / done / error
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let data = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }

        if (msg.type === 'progress') {
          progressSeen = true;
          const s = Math.round(msg.seconds);
          if (msg.phase === 'prompt') {
            $('spinProgress').textContent = `read ${msg.promptTokens} prompt tokens · writing…`;
          } else if (msg.phase === 'think') {
            $('spinProgress').textContent = `thinking… ${msg.tokens} tokens · ${s}s`;
          } else {
            const rate = msg.tokens > 0 && msg.seconds > 0 ? msg.tokens / msg.seconds : 0;
            $('spinProgress').textContent =
              `${msg.tokens} tokens written · ${s}s` +
              (rate > 0.05 ? ` · ${rate.toFixed(1)} tok/s` : '');
          }
        } else if (msg.type === 'status') {
          progressSeen = true;
          $('spinProgress').textContent = msg.message;
        } else if (msg.type === 'done') {
          data = msg.data;
        } else if (msg.type === 'error') {
          throw new Error(msg.error);
        }
      }
    }

    if (!data) throw new Error('Connection closed before a result was received.');
    organized = data;
    renderPreview(organized);
    $('downloadBtn').hidden = false;
    $('saveFolderBtn').hidden = false;
  } catch (err) {
    $('placeholder').hidden = false;
    showError(err.message);
  } finally {
    clearInterval(ticker);
    $('spinner').hidden = true;
    btn.disabled = false;
    btn.textContent = 'Organize notes →';
  }
}

// ---------- Preview rendering ----------
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

function renderPreview(d) {
  const el = $('preview');
  const parts = [];

  parts.push(`<h3 class="doc-title">${esc(d.title || 'Meeting Notes')}</h3>`);
  const meta = [];
  if (d.date) meta.push(esc(d.date));
  if (d.attendees?.length) meta.push('Attendees: ' + d.attendees.map(esc).join(', '));
  if (meta.length) parts.push(`<p class="doc-meta">${meta.join(' &nbsp;•&nbsp; ')}</p>`);
  parts.push('<hr>');

  if (d.summary) {
    parts.push(`<div class="sec">Summary</div><p>${esc(d.summary)}</p>`);
  }

  if (d.decisions?.length) {
    parts.push('<div class="sec">Key Decisions</div><ol>' +
      d.decisions.map((x) => `<li>${esc(x)}</li>`).join('') + '</ol>');
  }

  if (d.action_items?.length) {
    parts.push('<div class="sec">Action Items</div><table><thead><tr><th>#</th><th>Task</th><th>Owner</th><th>Due</th></tr></thead><tbody>' +
      d.action_items.map((a, i) =>
        `<tr><td>${i + 1}</td><td>${esc(a.task)}</td>` +
        `<td class="owner">${a.owner ? esc(a.owner) : '—'}</td>` +
        `<td class="due">${a.due ? esc(a.due) : '—'}</td></tr>`
      ).join('') + '</tbody></table>');
  }

  if (d.topics?.length) {
    parts.push('<div class="sec">Discussion Topics</div>');
    d.topics.forEach((t) => {
      if (t.heading) parts.push(`<div class="topic-head">${esc(t.heading)}</div>`);
      if (t.points?.length) {
        parts.push('<ul>' + t.points.map((p) => `<li>${esc(p)}</li>`).join('') + '</ul>');
      }
    });
  }

  if (d.open_questions?.length) {
    parts.push('<div class="sec">Open Questions &amp; Next Steps</div><ol>' +
      d.open_questions.map((q) => `<li>${esc(q)}</li>`).join('') + '</ol>');
  }

  el.innerHTML = parts.join('');
  el.hidden = false;
}

// ---------- Download ----------
$('downloadBtn').addEventListener('click', async () => {
  if (!organized) return;
  const btn = $('downloadBtn');
  btn.disabled = true;
  btn.textContent = 'Building PDF…';
  try {
    const res = await fetch('/api/pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: organized }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename="?([^";]+)"?/);
    const filename = m ? m[1] : 'meeting-notes.pdf';

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } catch (err) {
    showError('PDF download failed: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '↓ Download PDF';
  }
});

// ---------- Save to folder ----------
let lastDirHandle = null; // remembered native folder for one-click re-saves

function fsaAvailable() {
  // __noFSA is a test hook for browsers/contexts without the API
  return typeof window.showDirectoryPicker === 'function' && !window.__noFSA;
}

function showSaveMsg(text) {
  const el = $('saveMsg');
  el.textContent = text;
  el.hidden = false;
}

async function buildPdfBlob() {
  const res = await fetch('/api/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: organized }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const m = cd.match(/filename="?([^";]+)"?/);
  return { blob, filename: m ? m[1] : 'meeting-notes.pdf' };
}

$('saveFolderBtn').addEventListener('click', async () => {
  if (!organized) return;
  hideError();
  if (fsaAvailable()) {
    await saveViaNativeDialog();
  } else {
    openSavePanel('Tu navegador no soporta el diálogo de carpetas.');
  }
});

async function saveViaNativeDialog() {
  const btn = $('saveFolderBtn');
  btn.disabled = true;
  try {
    // Reuse the folder chosen earlier in this session when possible
    let handle = lastDirHandle;
    if (handle) {
      const q = await handle.queryPermission({ mode: 'readwrite' });
      if (q !== 'granted') {
        const r = await handle.requestPermission({ mode: 'readwrite' });
        if (r !== 'granted') handle = null;
      }
    }
    if (!handle) {
      handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'meeting-to-pdf' });
      lastDirHandle = handle;
    }

    const { blob, filename } = await buildPdfBlob();
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(blob);
    await writable.close();

    showSaveMsg(`PDF guardado en «${handle.name}» → ${filename}`);
  } catch (err) {
    if (err && err.name === 'AbortError') return; // user closed the dialog
    openSavePanel(err && err.message ? err.message : 'No se pudo abrir el diálogo.');
  } finally {
    btn.disabled = false;
  }
}

async function refreshChips() {
  // Build quick-chips from the folders that actually exist in this home
  try {
    const res = await fetch('/api/fs/list?dir=~');
    if (!res.ok) return;
    const home = await res.json();
    const entries = new Set(home.entries || []);
    const groups = [
      ['Downloads', 'Descargas'],
      ['Documents', 'Documentos'],
      ['Desktop', 'Escritorio'],
    ];
    const chips = [];
    for (const [en, es] of groups) {
      const name = entries.has(en) ? en : entries.has(es) ? es : null;
      if (name) chips.push({ path: '~/' + name, label: name });
    }
    const docs = entries.has('Documents') ? 'Documents'
      : entries.has('Documentos') ? 'Documentos' : '';
    chips.push({
      path: docs ? `~/${docs}/meeting-pdfs` : '~/meeting-pdfs',
      label: 'meeting-pdfs (se crea)',
    });

    const box = document.querySelector('.chips');
    box.innerHTML = '';
    chips.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'chip';
      b.dataset.path = c.path;
      b.textContent = c.label;
      box.appendChild(b);
    });
  } catch {
    /* keep the static chips */
  }
}

function openSavePanel(reason) {
  $('savePanel').hidden = false;
  $('savePath').value = store.get('mtfp-savedir', '~/Downloads');
  const msg = $('savePanelMsg');
  if (reason) {
    msg.textContent = reason + ' Escribe la ruta de la carpeta.';
    msg.hidden = false;
  } else {
    msg.hidden = true;
  }
  refreshChips();
  $('savePath').focus();
  $('savePath').select();
}

document.querySelector('.chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) $('savePath').value = chip.dataset.path;
});

$('saveCancelBtn').addEventListener('click', () => {
  $('savePanel').hidden = true;
});

$('saveConfirmBtn').addEventListener('click', async () => {
  const dir = $('savePath').value.trim();
  if (!dir) return;
  const btn = $('saveConfirmBtn');
  btn.disabled = true;
  btn.textContent = 'Guardando…';
  try {
    const res = await fetch('/api/pdf/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: organized, dir }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
    store.set('mtfp-savedir', dir);
    $('savePanel').hidden = true;
    showSaveMsg('PDF guardado en ' + out.path);
  } catch (err) {
    const msg = $('savePanelMsg');
    msg.textContent = err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Guardar aquí';
  }
});

// Ctrl/Cmd+Enter shortcut
$('notes').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate();
});

// ---------- Init ----------
(async function init() {
  await loadProviders();
  await loadModels();
  checkStatus();
  setInterval(checkStatus, 30000);
})();
