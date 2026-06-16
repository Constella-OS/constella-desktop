const { default: axios } = require('axios');
const { BACKEND_URL } = require('../constants');
const { getEmbeddingService } = require('./embedding/embedding-service');

// createEmbedding — turn raw text into a local 512-dim vector (document mode).
// Signature kept stable on purpose: every existing caller (file chunks, image
// captions, note sync, the file indexer) passes text and gets back a vector, now
// produced by EmbeddingGemma on node-llama-cpp instead of the old MiniLM pipeline.
// Returns null when the local model isn't available so callers fall back to cloud.
const createEmbedding = async (text) => {
  try {
    return await getEmbeddingService().embed(text, 'document');
  } catch (err) {
    console.error('Unable to create embedding');
    console.error(err);
    return null;
  }
};

// embedQuery — embed a SEARCH query (uses EmbeddingGemma's query task template).
// Use this for anything that searches the vector store so query/document prompts
// match; otherwise retrieval quality silently drops.
const embedQuery = async (text) => {
  try {
    return await getEmbeddingService().embed(text, 'query');
  } catch (err) {
    console.error('Unable to create query embedding');
    console.error(err);
    return null;
  }
};

// embedDocument — embed a stored note/chunk, optionally with its title as context.
const embedDocument = async (text, title) => {
  try {
    return await getEmbeddingService().embed(text, 'document', title);
  } catch (err) {
    console.error('Unable to create document embedding');
    console.error(err);
    return null;
  }
};

const API_BASE_URL = BACKEND_URL + 'constella_db/note';
const createEmbeddingFromBackend = async (text) => {
  try {
    const res = await axios.post(`${API_BASE_URL}/embed-text`, { text });
    return res.data.embedding;
  } catch (err) {
    console.error('Unable to create embedding from backend: ', err);
  }
};

module.exports = {
  createEmbedding,
  embedQuery,
  embedDocument,
  createEmbeddingFromBackend,
};
