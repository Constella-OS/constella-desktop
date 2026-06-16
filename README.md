# Constella

Constella is a private, open source, local-first desktop command center for your files, memories, agents, and workflows. It syncs folders you choose, builds a searchable local knowledge substrate, and uses local analysis jobs to turn scattered notes into connected concepts, themes, reminders, and recommendations.

**The goal:** one shared brain for your personal knowledge and agentic workflows.

<img width="1795" height="1130" alt="Constella JARVIS desktop screenshot" src="https://github.com/user-attachments/assets/c91e999c-6883-4f00-876a-66e152e9c9f5" />

### Want a simple download?

Download [here](https://constella.sh) — a curated UI based on our daily use testing, plus:

- Notion, Google Calendar, Slack, Gmail, Drive, and more integrations syncing in for automations
- Chrome Extension sidekick companion
- Mobile assistant

---

## What It Does

- Syncs local folders — Obsidian vaults, Downloads, Documents, agent workspaces, custom folders
- Indexes text-like files locally with a SQLite + vector store (LanceDB)
- Runs scheduled local analysis passes that cluster related material into durable concept pages and higher-order themes
- Surfaces insights, alerts, recommendations, source citations, and related concept links in the desktop UI
- Provides one command surface for Claude/Codex-powered agents and reusable workflows
- Exposes everything as MCP tools so Claude Code can search, read, and write to your knowledge base directly

## Current Status

Active desktop prototype. The core Electron/React shell, agent runner, local source registry, sync loop, SQLite/vector store, knowledge graph scheduler, and JARVIS-style UI are in place. Some surfaces are still evolving — especially the full constellation graph view, reminders, and automatic recommendation workflows.

Use it as a work-in-progress foundation for local-first personal AI tooling, not a polished production app yet.

---

## How It Works

Three layers compose into a complete local AI backend:

**1. Local source sync**

The main process owns a JSON-backed source registry. Each source maps to a folder — Obsidian vault, Downloads, Documents, agent folder, or any custom path. The app periodically checks enabled sources, extracts text from PDF/DOCX/MD/images, chunks the content, and embeds it into LanceDB using a local embedding model (EmbeddingGemma 512-dim, runs fully offline).

**2. Search and memory substrate**

Indexed content lands in LanceDB (vectors) and SQLite (metadata + full text). Searches run across all sources or a subset. The renderer calls into the main process via IPC — private files never leave your machine.

**3. Knowledge graph synthesis**

A scheduler runs clustering and synthesis passes so raw chunks become concept pages, themes, and edges. The graph lives in a local SQLite database. A scheduled LLM pass (local or cloud, your choice) connects related material across sources.

```
Local folders
  → file indexer (chunk + embed)
  → LanceDB vectors + SQLite metadata
  → scheduled graph pass
  → concept pages, themes, edges
  → UI: insights, alerts, agents, workflows
  → MCP: Claude Code reads/writes directly
```

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Renderer (React UI)                                 │
│  — swap with any interface you want                  │
└───────────────────────┬─────────────────────────────┘
                        │ IPC / MCP bridge
┌───────────────────────▼─────────────────────────────┐
│  Main process                                        │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │ File indexer │→ │  Knowledge   │  │    MCP    │  │
│  │              │  │    graph     │  │   bridge  │  │
│  │ PDF DOCX MD  │  │              │  │           │  │
│  │ images txt   │  │ concepts     │  │ Claude    │  │
│  └──────┬───────┘  │ themes edges │  │ Code ↔    │  │
│         │          └──────┬───────┘  │ your data │  │
│         ▼                 ▼          └───────────┘  │
│  ┌──────────────────────────────┐                   │
│  │  LanceDB (vectors)           │                   │
│  │  SQLite  (graph + notes)     │                   │
│  └──────────────────────────────┘                   │
│                                                      │
│  ┌──────────────────────────────┐                   │
│  │  AI pipeline                 │                   │
│  │  step → recipe → task        │                   │
│  │  local LLM or cloud          │                   │
│  └──────────────────────────────┘                   │
└─────────────────────────────────────────────────────┘
```

| Layer | Location | What it does |
|---|---|---|
| **File indexer** | `src/main/file-index/` | Watches folders, extracts text, chunks and embeds into LanceDB |
| **Knowledge graph** | `src/main/file-graph/` | Scheduled LLM pass → concepts, themes, edges in SQLite |
| **Local database** | `src/main/main-db/` | SQLite supervisor in a `worker_thread`, generic CRUD |
| **AI pipeline** | `src/utils/ai-pipeline/` | Step/recipe orchestration engine — pure composable functions |
| **MCP bridge** | `src/main/mcp/` | Exposes local knowledge as MCP tools for Claude Code |
| **Embeddings + LLM** | `src/main/ai/` | EmbeddingGemma 512-dim (offline) + local/cloud provider dispatch |

---

## Quick Start

### Requirements

- Node.js 18+
- macOS (Windows/Linux: community PRs welcome)

### Install

```bash
git clone https://github.com/Tej-Sharma/constella
cd constella
npm install
```

### Configure

```bash
cp .env.example .env.local
```

Fill in `.env.local` — only Firebase is required:

```env
# Required: your own Firebase project (free Spark tier works)
FIREBASE_API_KEY=
FIREBASE_AUTH_DOMAIN=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_MESSAGING_SENDER_ID=
FIREBASE_APP_ID=

# Optional: leave empty to disable
POSTHOG_TOKEN=
MIXPANEL_TOKEN=
SENTRY_DSN=
SENTRY_AUTH_TOKEN=
CONVERT_API_TOKEN=
```

**Firebase setup (3 steps):**
1. Create a project at [console.firebase.google.com](https://console.firebase.google.com) — free Spark plan is fine
2. Add a Web app → copy the config values into `.env.local`
3. Enable **Authentication → Sign-in method → Email/Password + Google**

### Run

```bash
npm start
```

---

## Customize the UI

The renderer entry is `src/components/open-source/OpenSourceApp.tsx`. Replace it with anything — the six core layers run in the main process regardless of what the renderer shows.

**IPC surface:**

```ts
// Semantic + keyword search
window.electron.ipcRenderer.invoke('mcp:request', {
  op: 'search_local_notes',
  params: { query: 'your query', limit: 10 }
})

// List / add indexed sources
window.electron.ipcRenderer.invoke('file-index:sources:list')
window.electron.ipcRenderer.invoke('file-index:sources:add', {
  path: '/Users/you/Documents/notes', label: 'My notes'
})

// Trigger sync
window.electron.ipcRenderer.invoke('file-index:sync-all')

// Knowledge graph
window.electron.ipcRenderer.invoke('file-graph:concepts')
window.electron.ipcRenderer.invoke('file-graph:themes')
```

**Ideas:**

- **Jarvis / FRIDAY style** — animated orb + voice input wired to MCP search
- **Obsidian-style editor** — TipTap in the renderer, persist via `db:upsert`, indexer picks up changes automatically
- **Salesforce dashboard** — table/kanban over `file-graph:concepts`, notes become structured records
- **Terminal UI** — xterm.js, pipe queries through `mcp:request`, full local RAG in a terminal

---

## MCP Integration with Claude Code

Once the app is running, Claude Code can call your local knowledge base directly. Add to your MCP config:

```json
{
  "constella": {
    "command": "node",
    "args": ["/path/to/constella/dist/main/main.js", "--mcp-only"]
  }
}
```

Available tools: `search_local_notes`, `list_sources`, `recent_notes`, `add_thought`.

---

## Privacy Model

- Your chosen folders are indexed on your machine only
- LanceDB and SQLite data live in `~/Library/Application Support/constella-core/` (macOS)
- Folder access is explicit — macOS native dialog grants permission per path
- Agent runs may call external CLIs or models depending on how Claude, Codex, or other providers are configured — review those tools before running them on private data

---

## Development

```bash
npm start          # dev server + Electron
npm run build      # production build
npm run package    # package for local testing
npm run release    # package + publish (requires .env.local with all secrets)
npm test           # jest
npm run lint       # eslint
```

### Repository layout

```
src/main/                 Electron main process
src/main/file-index/      File watcher, chunker, extractors, LanceDB upsert
src/main/file-graph/      Knowledge graph engine (concepts, themes, edges)
src/main/main-db/         SQLite worker_thread supervisor
src/main/mcp/             MCP bridge + server + tools
src/main/ai/              Embedding service, LLM runners
src/utils/ai-pipeline/    Step/recipe orchestration engine
src/components/           React UI (replace with your own)
assets/                   Icons and entitlements
tasks/                    Working notes and roadmap
```

---

## Contributing

Issues, ideas, and pull requests are welcome. The project moves quickly — small focused changes are easiest to review.

Before opening a pull request:

1. Run `npm run lint`
2. Run `npm test`
3. Keep changes scoped to one feature or fix
4. Include screenshots or logs for UI and sync behavior changes

---

## Security Notes

Constella reads local files from folders you configure. Be careful when adding large private directories, secrets folders, or workspaces containing credentials.

Agent execution can run external CLI tools. Treat prompts, tool permissions, and bypass modes with the same care you would use for any local automation running against your filesystem.

---

## License

Attribution-NonCommercial 4.0 International (CC BY-NC 4.0).

See [LICENSE](./LICENSE) and the official [Creative Commons legal code](https://creativecommons.org/licenses/by-nc/4.0/legalcode.txt).

Commercial use is not permitted without separate permission.
