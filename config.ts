import path from "path";
import os from "os";

// Available models for code embeddings
export const EMBEDDING_MODELS = {
  OLLAMA: {
    model: "unclemusclez/jina-embeddings-v2-base-code",
    contextSize: 8192,
    dimensions: 768,
    baseUrl: "http://127.0.0.1:11434",
  },
};



export const codeContextConfig = {
  ENV: process.env.NODE_ENV || "development",
  REPO_CONFIG_DIR:
    process.env.REPO_CONFIG_DIR ||
    path.join(os.homedir(), ".codeContextMcp", "repos"),

  // Performance tuning
  EMBEDDING_BATCH_SIZE: parseInt(process.env.EMBEDDING_BATCH_SIZE || "10", 10), // Reduced from 100 to 10 for stability
  FILE_PROCESSING_BATCH_SIZE: parseInt(process.env.FILE_PROCESSING_BATCH_SIZE || "50", 10), // Process files in smaller batches
  MAX_FILE_SIZE: parseInt(process.env.MAX_FILE_SIZE || "5000000", 10), // 5MB max file size
  MAX_CHUNK_SIZE: parseInt(process.env.MAX_CHUNK_SIZE || "50000", 10), // Maximum characters per chunk
  OLLAMA_REQUEST_BATCH_SIZE: parseInt(process.env.OLLAMA_REQUEST_BATCH_SIZE || "5", 10), // Max 5 texts per API request

  // Retry configuration
  MAX_RETRIES: parseInt(process.env.MAX_RETRIES || "3", 10),
  RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS || "1000", 10),
  REQUEST_TIMEOUT_MS: parseInt(process.env.REQUEST_TIMEOUT_MS || "30000", 10), // 30 seconds

  // Resource limits
  MAX_FILES_PER_BRANCH: parseInt(process.env.MAX_FILES_PER_BRANCH || "10000", 10),
  MAX_CHUNKS_PER_FILE: parseInt(process.env.MAX_CHUNKS_PER_FILE || "100", 10),

  DATA_DIR:
    process.env.DATA_DIR || path.join(os.homedir(), ".codeContextMcp", "data"),
  DB_PATH: process.env.DB_PATH || "code_context.db",
  EMBEDDING_MODEL: EMBEDDING_MODELS.OLLAMA,
};

export default codeContextConfig;
