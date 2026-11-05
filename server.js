'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const { spawn } = require('child_process');
const express = require('express');
const ollama = require('./lib/ollama');
const online = require('./lib/online');
const { normalize } = require('./lib/parse');
const { buildDoc, renderToBuffer } = require('./lib/pdf');

const PORT = process.env.PORT || 3000;
// Local-only by default: the app can write files to your disk.
const HOST = process.env.HOST || '127.0.0.1';
const app = express();

/** Safe filename slug from a meeting title. */
function slugify(s) {
  return (
    (s || '')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60)
      .toLowerCase() || 'meeting-notes'
  );
}

/**
 * Resolve and validate a target directory.
 * Only absolute paths inside the user's home directory are allowed.
 */
function resolveSafeDir(dir) {
  if (!dir || typeof dir !== 'string') throw new Error('Missing folder.');
  const raw = dir.trim().replace(/^~(?=$|\/)/, os.homedir());
  if (!path.isAbsolute(raw)) throw new Error('Folder must be an absolute path.');
  const p = path.resolve(raw);
  const home = os.homedir();
  if (p !== home && !p.startsWith(home + path.sep)) {
    throw new Error('Only folders inside your home directory are allowed.');
  }
  return p;
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Status ----------
app.get('/api/status', async (_req, res) => {
  const st = await ollama.status();
  const models = st.running ? await ollama.listModels() : [];
  res.json({ ...st, models });
});

// ---------- Provider registry (for the UI) ----------
app.get('/api/providers', (_req, res) => {
  res.json({
    providers: online.PROVIDERS.map((p) => ({
      id: p.id,
      label: p.label,
      shortLabel: p.shortLabel,
      needsKey: !!p.needsKey,
      askBaseUrl: !!p.askBaseUrl,
      local: !!p.local,
      defaultModel: p.defaultModel || null,
    })),
  });
});

// ---------- Model list for an online provider ----------
app.post('/api/models', async (req, res) => {
  const { provider: id, apiKey, baseUrl } = req.body || {};
  const p = online.getProvider(id);
  if (!p) return res.status(400).json({ error: 'Unknown provider.' });
  if (p.local) {
    const st = await ollama.status();
    const models = st.running ? await ollama.listModels() : [];
    return res.json({ models: models.map((m) => m.name), local: true, running: st.running });
  }
  const result = await online.listOnlineModels(p, { apiKey, baseUrl });
  res.json(result);
});

// ---------- Start Ollama on demand ----------
let starting = false;
app.post('/api/ollama/start', async (_req, res) => {
  if (starting) return res.json({ ok: true, alreadyStarting: true });
  starting = true;
  try {
    const child = spawn('ollama', ['serve'], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.on('error', (err) => {
      starting = false;
      console.error('Failed to spawn ollama serve:', err.message);
    });
    child.unref();

    // wait up to ~8s for it to come up
    for (let i = 0; i < 16; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await ollama.status();
      if (st.running) {
        starting = false;
        const models = await ollama.listModels();
        return res.json({ ok: true, version: st.version, models });
      }
    }
    starting = false;
    res.json({ ok: false, error: 'Ollama did not start within 8 seconds' });
  } catch (err) {
    starting = false;
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Organize notes (AI, streams NDJSON progress) ----------
app.post('/api/organize', async (req, res) => {
  const { notes, model, meta = {}, provider: providerId, apiKey, baseUrl } = req.body || {};
  if (!notes || typeof notes !== 'string' || !notes.trim()) {
    return res.status(400).json({ error: 'Please provide meeting notes.' });
  }
  if (!model) return res.status(400).json({ error: 'No model selected.' });

  const provider = online.getProvider(providerId || 'ollama');
  if (!provider) return res.status(400).json({ error: 'Unknown provider.' });

  res.set({
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const started = Date.now();

  try {
    const doExtract = (extraNote = '') => {
      const onProgress = (info) => send({ type: 'progress', ...info });
      if (provider.local) {
        return ollama.extractStream(model, notes.trim() + extraNote, meta, onProgress);
      }
      send({ type: 'status', message: `Contacting ${provider.shortLabel}…` });
      return online.extractOnline({
        provider,
        model,
        apiKey,
        baseUrl,
        notes: notes.trim() + extraNote,
        meta,
        onProgress,
      });
    };

    let raw = await doExtract();
    let data;
    try {
      data = normalize(raw);
    } catch (firstErr) {
      // One retry: ask the model to fix its own output
      console.warn(`JSON parse failed (${firstErr.message}), retrying...`);
      send({ type: 'status', message: 'Output was invalid — asking the model to retry, shorter…' });
      raw = await doExtract(
        '\n\nYour previous answer was cut off and not valid JSON. Return ONLY the JSON object, SHORTER: at most 2 decisions, 3 action items, 2 topics with 3 points each, 2 open questions.'
      );
      data = normalize(raw);
    }
    send({ type: 'done', data, seconds: (Date.now() - started) / 1000 });
  } catch (err) {
    console.error('organize failed:', err.message);
    send({ type: 'error', error: err.message });
  }
  res.end();
});

// ---------- Build PDF from organized data ----------
function buildPdfResponse(clean) {
  const docDef = buildDoc(clean, { generatedAt: new Date().toLocaleString() });
  const filename = slugify(clean.title);
  return { docDef, filename };
}

app.post('/api/pdf', async (req, res) => {
  const { data } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing organized data.' });
  }
  try {
    const clean = normalize(data);
    const { docDef, filename } = buildPdfResponse(clean);
    const buf = await renderToBuffer(docDef);
    res
      .set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}.pdf"`,
        'Content-Length': buf.length,
      })
      .send(buf);
  } catch (err) {
    console.error('pdf failed:', err);
    res.status(500).json({ error: 'PDF generation failed: ' + err.message });
  }
});

// ---------- Save PDF directly to a folder on this machine ----------
app.get('/api/fs/list', async (req, res) => {
  try {
    const dir = resolveSafeDir(String(req.query.dir || '~'));
    const st = await fsp.stat(dir);
    if (!st.isDirectory()) throw new Error('Not a folder: ' + dir);
    const items = await fsp.readdir(dir, { withFileTypes: true });
    const entries = items
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(dir);
    res.json({
      dir,
      home: os.homedir(),
      parent: parent === dir ? null : parent,
      entries,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/pdf/save', async (req, res) => {
  const { data, dir } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing organized data.' });
  }
  try {
    let target = resolveSafeDir(dir);
    try {
      const st = await fsp.stat(target);
      if (!st.isDirectory()) throw new Error('Not a folder: ' + target);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // Folder doesn't exist yet — create it (still validated inside home)
      await fsp.mkdir(target, { recursive: true });
    }

    const clean = normalize(data);
    const { docDef, filename } = buildPdfResponse(clean);
    const buf = await renderToBuffer(docDef);

    // Avoid overwriting: report.pdf, report (1).pdf, report (2).pdf …
    let file = path.join(target, `${filename}.pdf`);
    for (let n = 1; n < 1000; n++) {
      try {
        await fsp.access(file, fs.constants.F_OK);
        file = path.join(target, `${filename} (${n}).pdf`);
      } catch {
        break; // does not exist — use it
      }
    }

    await fsp.writeFile(file, buf);
    res.json({ path: file, bytes: buf.length });
  } catch (err) {
    console.error('save failed:', err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`meeting-to-pdf running at http://localhost:${PORT} (bound to ${HOST})`);
});
