/**
 * Embedding constants for the local EmbeddingGemma-300M model.
 *
 * We embed locally with Google's EmbeddingGemma-300M (GGUF, Q8_0) running on the
 * SAME node-llama-cpp runtime the chat LLM uses — there is no second native stack.
 * The model outputs 768-dim vectors; we keep the first 512 (Matryoshka truncation,
 * near-lossless ~0.7% MTEB drop) and re-normalize. 512 is the dimension stored in
 * the local LanceDB cache.
 *
 * IMPORTANT (scope): these vectors are LOCAL ONLY. The backend re-embeds every note
 * server-side (1024-dim) on insert/update/search, so changing the local dimension
 * does not touch cloud data — it only affects the offline / fallback LanceDB store.
 */

import type { ModelConfig } from '../llm-config';

// The native model emits 768 dims; we truncate to this for storage + search.
export const EMBEDDING_FULL_DIM = 768;
export const EMBEDDING_DIM = 512;

// Bump this whenever the model or target dimension changes. The reindex service
// compares it against the marker persisted on disk to decide whether the local
// vector store must be rebuilt (and only ever rebuilds once per version).
export const EMBEDDING_VERSION = 'embeddinggemma-300m-q8-512-v1';

// GGUF model descriptor. Public, ungated repo on the HF CDN — downloads with the
// same plain LLMDownloadService used for the chat models (no auth token needed).
export const EMBEDDING_MODEL: ModelConfig = {
  id: 'embeddinggemma-300m-q8',
  name: 'EmbeddingGemma 300M Q8_0',
  description:
    'Google EmbeddingGemma-300M text embedding model (Q8_0). Multilingual (100+ languages), 2048-token context. Used for local note/search embeddings.',
  url: 'https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/main/embeddinggemma-300M-Q8_0.gguf',
  filename: 'embeddinggemma-300M-Q8_0.gguf',
  size: 334000000, // ~334 MB
  quantization: 'Q8_0',
  contextSize: 2048,
  recommended: false,
};

// EmbeddingGemma is prompt-conditioned: queries and documents MUST be wrapped in
// the model's task templates or retrieval quality silently drops. These mirror the
// official "search result" retrieval task prompts.
export type EmbeddingKind = 'query' | 'document';

// Wraps a search query in the retrieval-query template.
export const formatQueryForEmbedding = (text: string): string =>
  `task: search result | query: ${text ?? ''}`;

// Wraps a stored document/chunk in the retrieval-document template. Title is
// optional context the model uses; "none" is the documented placeholder.
export const formatDocumentForEmbedding = (
  text: string,
  title?: string | null,
): string => `title: ${title && title.trim() ? title.trim() : 'none'} | text: ${text ?? ''}`;
