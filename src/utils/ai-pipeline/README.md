# AI Pipeline

A unified, mode-aware orchestration layer for every AI task in Constella —
recall, initial-project generation, Stella chat, and anything new. It replaces
the per-endpoint monoliths (each backend route hard-coding its own
expand → retrieve → filter → synthesize block) with **small reusable functions
composed into recipes and run by one engine**.

> TL;DR: an AI task = a **recipe** (an ordered list of steps). A **step** is a
> plain `(input, ctx) => output` function. A recipe is *itself* a step, so
> recipes nest (fractal composition). One **runner** executes any recipe,
> threading each step's output into the next and streaming progress as
> `NormalizedEvent`s. Two independent knobs on `ctx` decide behaviour: **data
> mode** (`local` / `cloud` / `hybrid`) and **provider** (`cloud` / `local` /
> `claude-cli` / `codex`).

---

## Why this exists

The backend had three near-identical pipelines with divergent tails:

| | recall (`ai-search`) | stella-v2 chat | initial-project-generate |
| --- | --- | --- | --- |
| **retrieve layer** | expand → hybrid-search → dedup → enrich → graph-expand | same retrieval, as a tool | expand → retrieve → resolve-chunks → fill-bodies → filter |
| **synthesize layer** | LLM-filter → `{title, insights, sources}` | stream text + `generate_personalized_ui` / `generate_mind_map` tools | text: `{themes[]}` · mindmap: node-select → classify-connections → `{nodes,edges}` |

The retrieve layer was already shared code; the pain was (a) orchestration glue
baked into each route and (b) the synthesis tails. **Every synthesis tail is the
same primitive** — *"call a structured-output LLM with prompt P and JSON schema
S over evidence E."* The differences are just P and S. So the whole surface
collapses to a handful of reusable steps plus a bag of prompt/schema pairs — and
each of those steps can run locally, in the cloud, or both.

---

## Core concepts

### Step — the atom

```ts
type Step<In, Out> = (input: In, ctx: StepCtx) => Promise<Out>;
```

A step does one thing: generate queries, run a search, dedup, rank, synthesize.
That's it. Atomic steps live in [`steps/`](./steps).

### Recipe — a composition that is also a step

```ts
function recipe(steps: Step[]): Step {
  return async (input, ctx) => {
    let data = input;
    for (const step of steps) data = await step(data, ctx);
    return data;
  };
}
```

`recipe([...])` returns a `Step`, so **a recipe is usable anywhere a step is.**
That single fact is the whole design: `retrieve` is a recipe, and `recall` is a
recipe that uses `retrieve` as one of its steps. Compositions live in
[`recipes/`](./recipes).

### Runner — executes a recipe

`runRecipe(recipe, input, ctx)` runs the top-level recipe. Because recipes nest,
running `aiSearch` automatically runs `retrieve` as a sub-pipeline. The runner
also exposes `fanOut(...)` for steps that run on the same input concurrently
(e.g. local + cloud search at once). See [`runner.ts`](./runner.ts).

**Where it runs:** the runner + steps execute in the **renderer** — that's where
RxDB content, the chat store, `emit`/UI, `performCloudWebSearch`, and the provider
IPC bridges already live. Steps that need a main-process resource cross via
existing IPC and return:

- `localSearch` → `query-lancedb` IPC → main (LanceDB **vector scan — ids only**)
  → back in the renderer, `parseVectorDBSearchResults` **hydrates content from
  RxDB** (LanceDB stores no content; NoteRxdbData / NoteBodyRxdbData do).
- local / CLI synthesis → `provider:run-once` / `provider:run` /
  `llm-stream-message` IPC → main worker / child process.
- `cloudSearch` / cloud synthesize → `axios` → backend (no main hop).

A main-side entry (`runOnceMain` in `src/main/providers/runner.ts`) exists for
headless/background callers, but anything needing local note **content** must
orchestrate in the renderer (RxDB is renderer-only).

### StepCtx — the two knobs + streaming

```ts
interface StepCtx {
  mode: 'local' | 'cloud' | 'hybrid';   // WHERE data comes from
  provider: ProviderId;                  // WHO runs the model (cloud/local/claude-cli/codex)
  userId: string;
  accessToken?: string;
  signal?: AbortSignal;
  emit: (event: NormalizedEvent) => void; // stream progress + final frames to the UI
}
```

`ctx` flows unchanged through every step. Steps read `mode` and `provider` to
self-configure; they never branch on "am I in recall or mindmap" — they just do
their one job. See [`ctx.ts`](./ctx.ts).

---

## The two independent axes

Keep these separate in your head — they compose freely:

| Axis | Controls | Set by | Lives in |
| --- | --- | --- | --- |
| **data mode** (`local`/`cloud`/`hybrid`) | what `retrieve` queries | data-mode toggle | the `retrieve` recipe (one place) |
| **provider** (`cloud`/`local`/`claude-cli`/`codex`) | who runs `generateQueries` + `synthesize` | existing `ProviderToggle` | `ctx.provider`, read by model-bound steps |

"Local data + cloud data, synthesized by local Qwen" is valid. So is "local-only
data, synthesized by claude-cli." The data axis is isolated to the retrieve step;
the provider axis is isolated to the model-bound steps.

---

## How `local + cloud` (hybrid) works

Hybrid is a property of **one step** (`retrieve`), not the whole pipeline. The
runner runs one pipeline; only `retrieve` fans out to both sources and merges.
Everything downstream is source-agnostic.

```
[1] generateQueries   runs ONCE on ctx.provider          → {specific,broad,tags}
[2] retrieve ───────── the only mode-aware step
      ├─ localSearch   (gated on: mode !== 'cloud')  ─┐ parallel
      ├─ cloudSearch   (gated on: mode !== 'local')  ─┘
      └─ dedupByUniqueId  → merged RelevantNote[] (each tagged origin)
[3] filterRank        runs ONCE on ctx.provider          → ranked evidence
[4] synthesize        runs ONCE on ctx.provider          → structured JSON
```

### Hard constraint: vectors are NOT in the same space

Local embeddings are **EmbeddingGemma 512-dim** (offline/fallback only); cloud is
**768-dim, re-embedded server-side** (source of truth). A local score of 0.7 and
a cloud 0.7 are **not comparable**. Therefore:

- **Merge result sets, never scores.** `dedupByUniqueId` dedups by `uniqueid`,
  keeps the cloud record on conflict (it has Postgres full content + graph
  edges), and appends local-only notes (your indexed folders the cloud can't
  see). Every record carries `origin: 'local' | 'cloud'`.
- **`filterRank` is the equalizer.** Since you can't trust a unified vector
  score, the merged pile passes through an LLM relevance pass that ranks/drops by
  actual relevance to the query. The model normalizes what the vectors can't.
- **Graceful degrade.** If cloud fails in hybrid mode, the merge returns local
  results and the pipeline continues (the backend-first / local-fallback rule,
  now one explicit merge point instead of scattered try/catch).

> There is currently **no `local-only` vs `cloud-synced` flag** on note models —
> origin is inferred from `integrationName`/`subtype`. The `origin` field this
> layer adds is the explicit version of that.

---

## How `synthesize` forces structure across providers

One JSON Schema (in [`schemas/`](./schemas)) drives **three** binding mechanisms,
selected by provider kind. This is also how local/CLI reach output parity with
the cloud's `personalized_ui` / `mind_map` / themes.

| Provider kind | Binding | Where |
| --- | --- | --- |
| **cloud** | backend `response_format` / structured output | `synthesize` cloud impl → `/pipeline/synthesize` |
| **local** (Qwen) | **GBNF grammar** derived from the schema (node-llama-cpp native JSON-schema grammar) | `src/main/providers/localLlmClient.ts` worker |
| **claude-cli / codex** | **strict pre-prompt + balanced-brace extractor** | [`binding/`](./binding) |

The CLI binding: append a strict instruction ("output ONLY a single JSON object
matching this schema, begin with `{`, end with `}`, no prose/fences"), then run a
**string-aware balanced-brace scanner** over the streamed text — skip to the
first `{`, track depth while respecting `"…"` strings and `\` escapes, capture
until depth returns to 0, ignore everything else (leading "thinking", trailing
prose, ``` ```json ``` fences). Validate against the schema; on a miss, one
strict re-ask. Once a complete valid object arrives, emit the same `ui` / `sources`
`NormalizedEvent`s the cloud emits — so the UI is identical regardless of who ran.

---

## Directory layout

```
src/utils/ai-pipeline/
├── README.md             # this file
├── types.ts              # Step<In,Out>, Recipe, StepCtx, PipelineMode, Origin
├── runner.ts             # recipe(), parallel(), runRecipe() — the engine
├── ctx.ts                # buildStepCtx({mode, provider, auth, emit})
├── index.ts              # public surface (what the entry hook imports)
│
├── steps/                # ATOMIC — one single-purpose function per file
│   ├── generateQueries.ts    # LLM (ctx.provider) → {specific,broad,tags}
│   ├── localSearch.ts        # IPC→main LanceDB + MiniSearch; no-op on web
│   ├── cloudSearch.ts        # thin wrap of utils/retrieval/cloud-search.ts
│   ├── dedupByUniqueId.ts    # pure; cloud wins, local-only appended, tags origin
│   ├── filterRank.ts         # LLM equalizer over merged evidence
│   └── synthesize.ts         # LLM + schema binding (dispatches by provider kind)
│
├── recipes/              # COMPOSITIONS — header tags each FRAGMENT or TASK
│   ├── retrieve.ts           # FRAGMENT: [generateQueries, parallel(local,cloud), dedup]
│   └── recall.ts             # TASK:     [retrieve, filterRank, synthesize]
│
├── schemas/              # JSON Schema — one per structured output; drives all 3 bindings
│   └── recallInsights.schema.ts
│
└── binding/              # how `synthesize` forces structure per provider kind
    ├── structuredPrompt.ts   # strict "emit only {…}" pre-prompt builder
    └── jsonExtract.ts        # balanced-brace streaming extractor (claude/codex)
```

**Conventions**

- `steps/` are leaves: one job, one file, easy to read/test. Most are thin
  adapters over code that already exists (`cloudSearch` wraps
  `utils/retrieval/cloud-search.ts`; `localSearch` wraps the main-side LanceDB
  IPC; `generateQueries`/`synthesize` wrap the provider abstraction). This is
  glue, not reinvention.
- `recipes/` hold anything composed. A one-line header comment marks each file as
  `FRAGMENT` (reused inside other recipes, e.g. `retrieve`) or `TASK` (a
  user-facing entry point, e.g. `recall`).
- `schemas/` are first-class because one schema feeds three bindings. Use the
  `.schema.ts` suffix so they're greppable.
- `binding/` isolates provider-kind specifics so `synthesize.ts` stays readable.

---

## Platform gating (web ↔ desktop)

Per [`IMPORTANT.md`](../../../IMPORTANT.md), this is a shared web+desktop tree.
`types.ts`, `runner.ts`, `recipes/`, and `schemas/` are **pure** (no DOM/electron
imports). Only `localSearch.ts` touches the desktop seam — it gates via
`getPlatform()` and is a no-op on web. On web, `mode` is effectively always
`cloud` and the provider is always `cloud`, so the web build compiles with
cloud-only steps and behaves exactly as today.

---

## Integration points (outside this dir)

| Location | Role |
| --- | --- |
| `src/utils/providers/useProviderRecall.ts` | thin **entry**: `buildStepCtx()` → `runRecipe(recall, query, ctx)`. Events already flow to `applyNormalizedToChat`, so the chat UI is unchanged. |
| `src/utils/providers/*` | provider layer (run one model + stream `NormalizedEvent`s). The pipeline calls *into* it; it does not know about pipelines. |
| `src/utils/retrieval/cloud-search.ts` | existing cloud search; `cloudSearch` step wraps it. |
| `src/main/providers/localLlmClient.ts` | gains **grammar** support so local Qwen honours a schema. |
| backend repo (`/pipeline/{retrieve,synthesize}`) | stateless per-step RPCs the cloud impls call. `/synthesize` (structured LLM over evidence) replaces the bespoke synthesis tails. |

---

## Relationship to the provider layer

`src/utils/providers/` answers *"run one model and stream events."* `ai-pipeline`
answers *"orchestrate a sequence of steps, any of which may be a model call, a
retrieval, or a pure transform — and stream the same events."* The pipeline is a
**generalization of the provider layer**: `dispatchRecall` today is a one-step
runner (pick cloud-WS vs bridged provider); this layer grows that into an N-step,
nesting, mode-aware engine while keeping the same `NormalizedEvent` output so
nothing downstream changes.

---

## Adding a new task

1. Define its output shape in `schemas/<name>.schema.ts`.
2. Reuse `recipes/retrieve.ts` for evidence (you get local/cloud/hybrid free).
3. Write the tail steps you need in `steps/` (or reuse `synthesize`).
4. Compose them in `recipes/<name>.ts` as a `TASK`.
5. Call `runRecipe(<name>, input, ctx)` from the relevant UI entry point.

No new endpoint, no new orchestration block — just a new recipe.
