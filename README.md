### Star this GitHub to be notified on launch

<img width="372" height="183" alt="image" src="https://github.com/user-attachments/assets/79aed1f3-3852-4d97-9f7e-32b311e7d0f9" />


### 👉 Get the easy-to-install download here [here](https://constella.sh)

## About this Project

Constella is a free, open source, local-first desktop command center for your files, memories,
agents, and workflows. It syncs folders you choose, builds a searchable local
knowledge substrate, and uses local analysis jobs to turn scattered notes into
connected concepts, themes, reminders, and recommendations.

The goal is simple: one shared brain for your personal knowledge and agentic
workflows.


<img width="1795" height="1130" alt="Constella JARVIS desktop screenshot" src="https://github.com/user-attachments/assets/c91e999c-6883-4f00-876a-66e152e9c9f5" />

## What It Does

- Syncs local folders such as Obsidian vaults, Downloads, Documents, agent
  workspaces, and custom folders.
- Indexes text-like files locally with a qmd-backed SQLite/vector store.
- Runs scheduled local analysis passes that cluster related material into
  durable concept pages and higher-order themes.
- Surfaces insights, alerts, recommendations, source citations, and related
  concept links in the desktop UI.
- Provides one command surface for Claude/Codex-powered agents and reusable
  workflows.
- Keeps the knowledge base human-readable with markdown wiki files plus a
  SQLite sidecar for graph queries and scheduling state.

## Current Status

This repository is an active desktop prototype. The core Electron/React shell,
agent runner, local source registry, qmd sync loop, wiki sidecar database,
scheduler, and JARVIS-style UI are in place. Some product surfaces are still
stubbed or evolving, especially the full constellation graph view, reminders,
and automatic recommendation workflows.

Use it as a work-in-progress foundation for local-first personal AI tooling,
not as a polished production app yet.

## How It Works

Constella has three layers:

1. **Local source sync**

   The main process owns a JSON-backed source registry. Each source maps to one
   qmd collection and can point at an Obsidian vault, Downloads, Documents, an
   agent folder, or any custom folder. The app periodically checks enabled
   sources and runs qmd update/embed when content changes or the sync interval
   elapses.

2. **Search and memory substrate**

   qmd stores indexed content in the app's user data directory using SQLite,
   sqlite-vec, and local embedding infrastructure. Searches can run across all
   default collections or a selected subset. The renderer uses IPC to manage
   sources, trigger syncs, and search local knowledge without shipping private
   files to a remote service.

3. **Wiki and constellation synthesis**

   A wiki folder is scaffolded under the app's user data directory. Markdown
   pages are the human-readable source of truth; `meta.sqlite` is the derived
   graph and scheduling index. A scheduler runs clustering, extraction, and
   synthesis passes so raw chunks become concept pages, themes, links, and UI
   artifacts.

The intended flow is:

```text
Local folders
  -> qmd collections
  -> local SQLite/vector index
  -> scheduled clustering
  -> concept pages and syntheses
  -> JARVIS UI: themes, sources, alerts, recommendations, agents
```

## Privacy Model

Constella is designed around local-first operation:

- Your chosen folders are indexed on your machine.
- qmd data lives in the Electron `userData` directory.
- Wiki pages and the sidecar database live under `userData/wiki`.
- Folder access is explicit. On macOS, picking a folder through the native
  dialog grants the app permission for that path.

Agent runs may call external CLIs or models depending on how Claude, Codex, or
other providers are configured on your machine. Review those tools separately
before running them on private data.

## Features

### Sync Sources

The settings panel supports:

- Obsidian vaults
- Downloads
- Documents
- Custom folders
- Per-source sync state and errors
- Manual sync
- macOS Full Disk Access guidance when a source cannot be read

Default file patterns favor text and markdown-friendly formats.

### Local Search

The qmd IPC layer exposes:

- Source CRUD
- Preset source discovery
- Per-source sync
- Sync all
- Search with optional collections, limits, minimum scores, and reranking
- Status readouts for debugging and UI state

### Wiki Memory

The wiki backend stores:

- Concept pages
- Synthesis pages
- Page sources and citations
- Page links
- Clusters
- Artifacts such as insights, alerts, and recommendations
- Run history
- Ingest cursors for scheduled jobs

The long-term design is a compounding markdown wiki rather than a purely
query-time RAG interface.

### Agents and Workflows

The app can launch Claude or Codex CLI runs from the desktop UI. The runner:

- Detects installed agent binaries
- Streams NDJSON output back to the renderer
- Normalizes text, tool, error, and metadata events
- Keeps per-agent scratch/log directories
- Supports cancellation and cleanup on quit

Workflows are intended to let agents share the same local memory substrate
instead of each agent operating from an isolated context.

## Customization

### Add Local Sources

Open the Sync Sources settings panel and add one of the presets or choose any
folder. For custom sources, the app defaults to markdown files and ignores
common generated folders such as `.git` and `node_modules`.

### Tune Source Behavior

Source records include:

- `name`
- `path`
- `kind`
- `pattern`
- `ignore`
- `syncEnabled`
- `syncIntervalMin`
- `includeByDefault`

These are stored in `sources.json` under Electron `userData`.

### Change App Appearance

The renderer is a React app with the main HUD styling in:

- `src/renderer/jarvis.css`
- `src/renderer/App.css`
- `src/renderer/theme.ts`

### Extend the Wiki Pipeline

Most wiki work lives in:

- `src/main/wiki/scaffold.ts`
- `src/main/wiki/store.ts`
- `src/main/wiki/clusters.ts`
- `src/main/wiki/extract.ts`
- `src/main/wiki/synthesize.ts`
- `src/main/wiki/scheduler.ts`
- `src/main/wiki/linker.ts`

The IPC surface is in `src/main/wikiIpc.ts`.

### Add Agent Behavior

Agent execution is centralized in `src/main/agentRunner.ts`. Renderer
components can call the preload-exposed IPC APIs to start, stream, and cancel
runs.

## Development

### Requirements

- Node.js
- npm
- Electron-supported desktop OS
- Optional: Claude CLI and/or Codex CLI for agent execution

The qmd dependency is installed in `release/app` and may download local model
assets on first sync/search.

### Install

```bash
npm install
```

### Start Development App

```bash
npm start
```

### Build

```bash
npm run build
```

### Package

```bash
npm run package
```

### Test

```bash
npm test
```

### Lint

```bash
npm run lint
```

## Repository Layout

```text
src/main/                 Electron main process
src/main/qmdService.ts    qmd store, sync loop, search
src/main/ragSources.ts    local source registry
src/main/wiki/            wiki scaffold, store, clustering, synthesis, scheduler
src/main/agentRunner.ts   Claude/Codex process runner
src/renderer/             React desktop UI
src/renderer/components/  HUD, chat, settings, source sync, workflow UI
release/app/              packaged app runtime dependencies
assets/                   app icons and entitlements
tasks/                    working notes and roadmap
```

## Roadmap

- Complete the constellation graph view backed by `wiki:graph`.
- Make concept page creation and linking more reliable across large local
  corpora.
- Add richer reminder and recommendation surfaces.
- Add user controls for merging, splitting, pinning, and locking wiki pages.
- Improve source parsers for PDFs, docs, browser exports, and rich media.
- Add workflow templates that can reuse synced memory safely.
- Add import/export for wiki pages, graph metadata, and agent configuration.
- Harden packaged app metadata, signing, and update flows.
- Add focused tests around source sync, wiki scheduling, and IPC contracts.

## Contributing

Issues, ideas, and pull requests are welcome. The project is still moving
quickly, so small focused changes are easiest to review.

Before opening a pull request:

1. Run `npm run lint`.
2. Run `npm test`.
3. Keep changes scoped to one feature or fix.
4. Include screenshots or logs for UI and sync behavior changes.

## Security Notes

Constella reads local files from folders you configure. Be careful when adding
large private directories, secrets folders, or workspaces containing credentials.

Agent execution can run external CLI tools. Treat prompts, tool permissions,
and bypass modes with the same care you would use for any local automation
running against your filesystem.

## License

Attribution-NonCommercial 4.0 International (CC BY-NC 4.0).
See [LICENSE](./LICENSE) and the official
[Creative Commons legal code](https://creativecommons.org/licenses/by-nc/4.0/legalcode.txt).

Commercial use is not permitted without separate permission.
