/**
 * EmbeddingService — local text embeddings via EmbeddingGemma-300M.
 *
 * Worker-backed facade: this class keeps the public API (embed / loadIfNeeded /
 * isReady / downloadModelIfNeeded) but the model load + the `getEmbeddingFor`
 * compute now run in a dedicated `utilityProcess` (embedding-client.ts →
 * embedding-worker.js), NOT on the main thread. So the ~334 MB EmbeddingGemma
 * model + per-chunk embedding never block main and stay isolated from the chat
 * model — matching agents-slack's rag-worker isolation. The GGUF download stays
 * here in main so its progress still streams to the renderer's UI.
 *
 * Embedding only works once the GGUF is downloaded; if it isn't (or the worker
 * fails), `embed` returns null and callers fall back to the cloud (which embeds
 * server-side anyway).
 */

import { LLMDownloadService } from '../llm-download';
import { EMBEDDING_MODEL, EmbeddingKind } from './embedding-constants';
import {
  embedViaWorker,
  warmEmbeddingWorker,
  embeddingWorkerReady,
  stopEmbeddingWorker,
} from './embedding-client';

export class EmbeddingService {
  private downloadService: LLMDownloadService;

  private downloadPromise: Promise<string> | null = null;

  // Resolved GGUF path, cached after first download so embed() doesn't re-stat
  // the file on every call.
  private cachedModelPath: string | null = null;

  // `sharedLlama` is accepted for API compatibility but unused now that the
  // model lives in the worker (there is nothing to share in the main process).
  // eslint-disable-next-line no-unused-vars, @typescript-eslint/no-unused-vars
  constructor(_sharedLlama?: any) {
    this.downloadService = new LLMDownloadService();
  }

  /** Absolute path the GGUF would live at once downloaded. */
  public getModelPath(): string {
    return this.downloadService.getModelPath(EMBEDDING_MODEL.filename);
  }

  /** True if the GGUF file is present on disk. */
  public async isModelDownloaded(): Promise<boolean> {
    return this.downloadService.isModelDownloaded(EMBEDDING_MODEL.filename);
  }

  /**
   * Ensure the GGUF is on disk, downloading it if missing (~334 MB). Runs in
   * main so download progress streams to the renderer UI. De-duped by
   * downloadPromise. Resolves to the local model path, or throws on failure.
   */
  public async downloadModelIfNeeded(): Promise<string> {
    if (this.cachedModelPath) return this.cachedModelPath;
    if (await this.isModelDownloaded()) {
      this.cachedModelPath = this.getModelPath();
      return this.cachedModelPath;
    }
    if (this.downloadPromise) return this.downloadPromise;

    const service = this.downloadService;
    this.downloadPromise = new Promise<string>((resolve, reject) => {
      const onCompleted = (info: { filename: string; filePath: string }) => {
        if (info.filename !== EMBEDDING_MODEL.filename) return;
        cleanup();
        resolve(info.filePath);
      };
      const onError = (info: { error: string }) => {
        cleanup();
        reject(new Error(info.error));
      };
      const cleanup = () => {
        service.off('completed', onCompleted);
        service.off('error', onError);
      };
      service.on('completed', onCompleted);
      service.on('error', onError);
      console.log('[Embedding] downloading EmbeddingGemma GGUF (~334 MB)…');
      service.startDownload(EMBEDDING_MODEL).catch((err) => {
        cleanup();
        reject(err);
      });
    }).finally(() => {
      this.downloadPromise = null;
    });

    return this.downloadPromise.then((p) => {
      this.cachedModelPath = p;
      return p;
    });
  }

  /**
   * Ensure the GGUF is downloaded and the worker has the model warm. Returns
   * false (rather than throwing) on any failure so embed() degrades to cloud.
   */
  public async loadIfNeeded(): Promise<boolean> {
    try {
      const modelPath = await this.downloadModelIfNeeded();
      return await warmEmbeddingWorker(modelPath);
    } catch (error) {
      console.error('[Embedding] Failed to warm embedding worker:', error);
      return false;
    }
  }

  /** True if the worker has loaded the model and can embed right now. */
  public isReady(): boolean {
    return embeddingWorkerReady();
  }

  /**
   * Embed a single string in the worker. `kind` selects the EmbeddingGemma task
   * template ('query' for searches, 'document' for stored notes/chunks). `title`
   * is optional context for the document template. Returns a 512-dim normalized
   * number[], or null when unavailable (caller should fall back to cloud).
   */
  public async embed(
    text: string,
    kind: EmbeddingKind = 'document',
    title?: string | null,
  ): Promise<number[] | null> {
    if (!text || !text.trim()) return null;
    let modelPath: string;
    try {
      modelPath = await this.downloadModelIfNeeded();
    } catch {
      return null; // not downloaded yet — caller falls back to cloud
    }
    return embedViaWorker(modelPath, text, kind, title);
  }

  /** Embed many strings of the same kind, sequentially. Nulls are kept in place. */
  public async embedBatch(
    texts: string[],
    kind: EmbeddingKind = 'document',
  ): Promise<(number[] | null)[]> {
    const out: (number[] | null)[] = [];
    for (const t of texts) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await this.embed(t, kind));
    }
    return out;
  }

  /** Tear down the worker (model + context). */
  public async dispose(): Promise<void> {
    stopEmbeddingWorker();
  }
}

// Process-wide singleton so every embed call shares one worker + loaded model.
let singleton: EmbeddingService | null = null;
export const getEmbeddingService = (): EmbeddingService => {
  if (!singleton) singleton = new EmbeddingService();
  return singleton;
};
