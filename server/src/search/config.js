// Embedding provider configuration. Kept free of imports so db.js can read the
// column width without pulling in the search modules (db -> embed -> stats -> db).
//
// Defaults target OpenAI. Point EMBEDDING_API_URL at any OpenAI-compatible
// server to run with no API key at all — e.g. Ollama:
//
//   EMBEDDING_API_URL=http://localhost:11434/v1/embeddings
//   EMBEDDING_MODEL=nomic-embed-text
//   EMBEDDING_DIMENSIONS=768
//
// EMBEDDING_DIMENSIONS must match the model's native width, and changing it
// means rebuilding page_chunks — the embedding column is typed vector(N).
const OPENAI_URL = 'https://api.openai.com/v1/embeddings';

export const EMBED_API_URL = process.env.EMBEDDING_API_URL || OPENAI_URL;
export const EMBED_MODEL = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
export const EMBED_DIMS = Number(process.env.EMBEDDING_DIMENSIONS) || 1536;

export const isOpenAI = EMBED_API_URL === OPENAI_URL;

// `dimensions` truncates OpenAI's Matryoshka embeddings. Local servers accept
// the field and silently ignore it, returning their native width — sending it
// would mask a mismatch until the vector insert failed. So: OpenAI only.
export const SEND_DIMENSIONS = isOpenAI;

// Local inference is free; the /api/health spend estimate is OpenAI-only.
export const USD_PER_MTOKEN = isOpenAI ? 0.02 : 0;
