# Meeting → PDF

Turn raw, messy meeting notes into a well-organized PDF — powered by AI.
Works **fully offline** (local Ollama) or with **free online models** — your choice.

## Features

- **Paste & organize** — paste raw notes; the AI extracts:
  - 📝 Summary
  - ✅ Key decisions
  - ✅ Action items (task / owner / due date)
  - 💬 Discussion topics
  - ❓ Open questions & next steps
- **Live preview** before downloading
- **One-click PDF** — clean, professional A4 layout (pdfmake)
- **Save to folder** — native folder dialog (Chrome/Edge) or a path panel with
  quick chips; files never overwrite (`report.pdf`, `report (1).pdf`, …)
- **Multiple AI sources** (see below) — including a free no-sign-up option
- **Streaming progress** — live tokens/sec while the model works
- **Auto-start Ollama** — one click starts the local server from the app

## AI sources

| Source | Cost | API key | Notes |
|---|---|---|---|
| **Free online (Pollinations)** | Free | ❌ none | Default. Works out of the box, fast (~15s/document) |
| **OpenRouter** | Free models | ✅ free key | Models ending in `:free` — get a key at openrouter.ai/keys |
| **Groq** | Free tier | ✅ free key | Very fast — console.groq.com/keys |
| **Google Gemini** | Free tier | ✅ free key | aistudio.google.com/apikey |
| **Local (Ollama)** | Free | ❌ | 100% offline; speed depends on your CPU (can be minutes) |
| **Custom** | — | optional | Any OpenAI-compatible server (LM Studio, llama.cpp, vLLM…) |

API keys are stored **only in your browser's localStorage** and sent with each
request — the app never writes them to disk.

> Note: with online sources your meeting notes are sent to that provider's API.
> Use **Local (Ollama)** if the notes are sensitive.

## Requirements

- Node.js 18+ (uses built-in `fetch`)
- For local mode: [Ollama](https://ollama.com) with at least one model, e.g.
  ```bash
  ollama pull qwen2.5:0.5b
  ```
  (Online mode needs no local model.)

## Run

```bash
npm install
npm start
```

Open **http://localhost:3000**, paste your notes, click **Organize notes →**,
preview, then **↓ Download PDF**.

## How it works

```
your notes ──► AI source (local Ollama or free online API) ──► validator ──► pdfmake ──► PDF
```

1. `lib/prompt.js` builds a compact extraction prompt (JSON schema).
2. `lib/ollama.js` / `lib/online.js` stream the model's response with live progress.
3. `lib/parse.js` validates/normalizes the response (one automatic retry if broken).
4. `lib/pdf.js` renders a styled A4 document: header, summary, numbered decisions,
   action-item table, topic bullets, open questions.

## Performance on weak hardware

Online models finish a document in seconds. Local models are only as fast as
your CPU — measured on a 2-core CPU without AVX: ~0.5–1 token/sec, i.e. several
minutes per document. Tips:

- Prefer a **free online source** for speed and better extraction quality.
- If running locally, **close other apps/tabs** — the model shares your CPU cores.
- The app shows live `tokens · seconds · tok/s` so you can see it progressing.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Web server port |
| `HOST` | `127.0.0.1` | Bind address (loopback only — the app can write files) |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama endpoint |
| `OLLAMA_TIMEOUT_MS` | `1800000` (30 min) | Max time for one local AI request |
| `ONLINE_TIMEOUT_MS` | `300000` (5 min) | Max time for one online AI request |

## API

- `GET /api/status` — Ollama health + installed models
- `GET /api/providers` — AI source registry for the UI
- `POST /api/models` — `{provider, apiKey?, baseUrl?}` → model list
- `POST /api/ollama/start` — spawn `ollama serve` in the background
- `POST /api/organize` — `{notes, model, provider, apiKey?, meta}` → NDJSON stream (`status` / `progress` / `done` / `error`)
- `POST /api/pdf` — `{data}` → PDF file download
- `GET /api/fs/list?dir=~` → subfolders of a directory (home-confined)
- `POST /api/pdf/save` — `{data, dir}` → writes the PDF on this machine, returns `{path, bytes}`

Save-to-folder security: paths must be absolute and resolve **inside your home
directory**; the server binds to `127.0.0.1` and exposes no CORS, so other
websites cannot reach these endpoints.
