/**
 * Embed text via the app's already-loaded EmbeddingGemma model (createEmbedding).
 * Reused by extract + synthesize so no second embedder is loaded. Returns a
 * plain number[] (createEmbedding yields a Float32Array) or null on failure.
 */
import { createEmbedding } from '../ai/create-embedding';

export async function embedText(text: string): Promise<number[] | null> {
  try {
    const v = await createEmbedding(text);
    return v ? Array.from(v as ArrayLike<number>) : null;
  } catch {
    return null;
  }
}
