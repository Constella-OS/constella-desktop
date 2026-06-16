/**
 * Embedding worker — runs as an Electron `utilityProcess` (separate OS process,
 * Electron's native ABI so node-llama-cpp loads correctly).
 *
 * Holds the EmbeddingGemma model + embedding context and runs `getEmbeddingFor`
 * HERE so the ~334 MB model + the embed compute never sit on the main process
 * (the embedder is now isolated from chat + the main thread, mirroring how the
 * chat LLM runs in local-llm-worker.js, and matching agents-slack's rag-worker).
 *
 * Plain CommonJS (raw .js, no transpile in dev/prod) like the other workers.
 *
 * Protocol (structured-clone messages over parentPort), mirrors local-llm-worker:
 *   main -> worker : { type:'call', id, method, args }
 *   worker -> main : { type:'ready' }
 *                    { type:'result', id, value }
 *                    { type:'error',  id, message }
 * Methods:
 *   warm({ modelPath, gpu, contextSize })                  -> loads the model
 *   embed({ modelPath, text, kind, title, dim, contextSize }) -> { vector:number[]|null }
 */

// node-llama-cpp is ESM-only — hide the import behind `new Function` so neither
// webpack nor tsx rewrites it into a require() (same trick the other workers use).
// eslint-disable-next-line no-new-func
const importLlama = new Function('return import("node-llama-cpp")');

const parentPort = process.parentPort;

function post(msg) {
  try {
    parentPort.postMessage(msg);
  } catch (e) {
    /* port closed during shutdown */
  }
}

let llama = null;
let model = null;
let context = null;
let loadedModelPath = null;

async function ensureLlama(gpu) {
  if (llama) return llama;
  const { getLlama } = await importLlama();
  llama = await getLlama({
    gpu: gpu === false ? false : 'auto',
    build: 'never',
    skipDownload: false,
  });
  return llama;
}

async function ensureModel({ modelPath, gpu, contextSize }) {
  await ensureLlama(gpu);
  if (model && loadedModelPath === modelPath) return;
  if (context) {
    try {
      await context.dispose();
    } catch (e) {
      /* ignore */
    }
    context = null;
  }
  if (model) {
    try {
      await model.dispose();
    } catch (e) {
      /* ignore */
    }
    model = null;
  }
  model = await llama.loadModel({ modelPath });
  context = await model.createEmbeddingContext({
    contextSize: contextSize || 2048,
  });
  loadedModelPath = modelPath;
}

// EmbeddingGemma task templates — MUST match embedding-constants.ts or retrieval
// quality silently drops.
function formatQuery(text) {
  return `task: search result | query: ${text ?? ''}`;
}
function formatDocument(text, title) {
  return `title: ${
    title && title.trim() ? title.trim() : 'none'
  } | text: ${text ?? ''}`;
}

// Truncate the 768-dim output to `dim` and L2-normalize (Matryoshka). Mirrors
// embedding-service.ts truncateAndNormalize.
function truncateAndNormalize(raw, dim) {
  const n = Math.min(dim, raw.length);
  const out = new Array(n);
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = raw[i];
    out[i] = v;
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm > 0) {
    for (let i = 0; i < n; i += 1) out[i] /= norm;
  }
  return out;
}

async function embed(args) {
  const o = (args && args[0]) || {};
  const {
    modelPath,
    text,
    kind,
    title,
    dim = 512,
    gpu,
    contextSize,
  } = o;
  if (!modelPath) throw new Error('embedding-worker: modelPath required');
  if (!text || !String(text).trim()) return { vector: null };
  await ensureModel({ modelPath, gpu, contextSize });
  const formatted =
    kind === 'query' ? formatQuery(text) : formatDocument(text, title);
  const emb = await context.getEmbeddingFor(formatted);
  const raw = emb && emb.vector ? emb.vector : emb;
  if (!raw || raw.length === 0) return { vector: null };
  return { vector: truncateAndNormalize(Array.from(raw), dim) };
}

parentPort.on('message', async (event) => {
  const msg = event && event.data;
  if (!msg || msg.type !== 'call') return;
  const { id, method, args } = msg;
  try {
    let value;
    if (method === 'warm') {
      const o = (args && args[0]) || {};
      await ensureModel({
        modelPath: o.modelPath,
        gpu: o.gpu,
        contextSize: o.contextSize,
      });
      value = { ok: true };
    } else if (method === 'embed') {
      value = await embed(args);
    } else {
      throw new Error(`embedding-worker: unknown method "${method}"`);
    }
    post({ type: 'result', id, value });
  } catch (err) {
    post({ type: 'error', id, message: (err && err.message) || String(err) });
  }
});

// Signal readiness only after the listener is attached so the client never
// races the first call.
post({ type: 'ready' });
