/**
 * Local LLM worker — runs as an Electron `utilityProcess` (separate OS process,
 * Electron's native ABI so node-llama-cpp loads correctly).
 *
 * Holds the ~0.6–8 GB model + context and runs inference here so the main
 * process event loop (and therefore IPC + the renderer) never stalls while a
 * local recall streams. This is the LocalProvider's backend.
 *
 * Plain CommonJS (not TS): the destination runs dev-main via tsx and bundles
 * prod-main with webpack, but worker files ride along as raw .js (same as the
 * existing src/main/ai/workers/*.js). A plain .js worker needs no transpile in
 * either mode.
 *
 * Protocol (structured-clone messages over parentPort), mirrors ragWorker:
 *   main -> worker : { type:'call', id, method, args }
 *   worker -> main : { type:'ready' }
 *                    { type:'result',   id, value }
 *                    { type:'error',    id, message }
 *                    { type:'progress', id, info }   // { text } per streamed chunk
 *
 * Methods:
 *   warm({ modelPath, gpu, contextSize })            -> loads the model
 *   run({ modelPath, prompt, systemPrompt, options, gpu, contextSize })
 *        -> streams { text } progress, resolves { text } (full assembled answer)
 *   cancel({ targetId })                             -> aborts an in-flight run
 */

// node-llama-cpp is ESM-only; hide the import behind `new Function` so neither
// webpack nor tsx rewrites it into a require() (same trick llm.ts uses).
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

// Number of parallel inference lanes on the ONE loaded model. The model weights
// are loaded once and shared across all sequences (no RAM duplication); only the
// KV cache scales, and it's a UNIFIED pool sized by contextSize shared across
// sequences. Multiple lanes let the user's recall AND the background file-graph
// engine query the same model concurrently (batched together) instead of
// colliding on a single sequence ("No sequences left") or serializing/stalling.
const SEQUENCES = 4;

// Cached model/context keyed by modelPath so repeated runs don't reload ~GBs.
let llama = null;
let loadedModelPath = null;
let model = null;
let context = null;

// Active in-flight runs: id -> AbortController, so `cancel` can stop a stream.
const aborters = new Map();

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

  // Switching model: tear down the old one first.
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
  // Auto-fit the context to available memory, up to the model's configured size
  // (e.g. Qwen3 = 32768). node-llama-cpp picks the largest that fits and retries
  // smaller on OOM (failedCreationRemedy). The old hard 4096 cap silently
  // truncated larger prompts and produced empty/garbled output. `sequences`
  // gives us SEQUENCES parallel lanes sharing this one model + KV pool.
  const maxCtx = contextSize || 8192;
  context = await model.createContext({
    sequences: SEQUENCES,
    contextSize: { max: maxCtx },
  });
  loadedModelPath = modelPath;
}

/**
 * Grab a free inference lane. With SEQUENCES lanes this normally returns
 * immediately; only a rare burst of more than SEQUENCES concurrent calls would
 * momentarily exhaust them — in that case we WAIT for one to free rather than
 * fail with "No sequences left" (which is what silently broke the recall).
 */
async function acquireSequence(maxWaitMs = 60000) {
  const start = Date.now();
  for (;;) {
    try {
      return context.getSequence();
    } catch (e) {
      const msg = (e && e.message) || '';
      if (!/no sequences left/i.test(msg) || Date.now() - start > maxWaitMs) {
        throw e;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

async function run(args, id) {
  const opts = (args && args[0]) || {};
  const {
    modelPath,
    prompt,
    systemPrompt,
    options = {},
    gpu,
    contextSize,
  } = opts;
  if (!modelPath) throw new Error('local-llm-worker: modelPath required');
  if (!prompt) throw new Error('local-llm-worker: prompt required');

  await ensureModel({ modelPath, gpu, contextSize });

  const { LlamaChatSession } = await importLlama();
  const sequence = await acquireSequence();
  const abort = new AbortController();
  aborters.set(id, abort);

  let full = '';
  try {
    const session = new LlamaChatSession({
      contextSequence: sequence,
      systemPrompt:
        systemPrompt ||
        'You are a helpful AI assistant integrated inside Constella. Answer directly using the provided context.',
    });

    full = await session.prompt(prompt, {
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      topP: options.topP,
      topK: options.topK,
      signal: abort.signal,
      // v3 streaming: fires with each decoded text chunk.
      onTextChunk: (chunk) => {
        if (chunk) post({ type: 'progress', id, info: { text: chunk } });
      },
    });
  } finally {
    aborters.delete(id);
    try {
      await sequence.dispose();
    } catch (e) {
      /* ignore */
    }
  }
  return { text: full };
}

parentPort.on('message', async (event) => {
  const msg = event && event.data;
  if (!msg || msg.type !== 'call') return;
  const { id, method, args } = msg;

  // cancel is synchronous-ish: abort the target run, ack immediately.
  if (method === 'cancel') {
    const targetId = args && args[0] && args[0].targetId;
    const a = targetId != null ? aborters.get(targetId) : null;
    if (a) a.abort();
    post({ type: 'result', id, value: { cancelled: Boolean(a) } });
    return;
  }

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
    } else if (method === 'run') {
      value = await run(args, id);
    } else {
      throw new Error(`local-llm-worker: unknown method "${method}"`);
    }
    post({ type: 'result', id, value });
  } catch (err) {
    post({ type: 'error', id, message: (err && err.message) || String(err) });
  }
});

// Signal readiness only after the listener is attached so the client never
// races the first call.
post({ type: 'ready' });
