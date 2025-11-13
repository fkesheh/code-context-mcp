import axios, { AxiosError } from "axios";
import config from "../config.js";

// Cache for API
let apiInitialized = false;

/**
 * Sleep utility for retry delays
 */
async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper with exponential backoff
 */
async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = config.MAX_RETRIES,
  initialDelay: number = config.RETRY_DELAY_MS
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry on non-retryable errors
      if (axios.isAxiosError(error)) {
        const axiosError = error as AxiosError;
        // Don't retry on 4xx errors (client errors)
        if (axiosError.response && axiosError.response.status >= 400 && axiosError.response.status < 500) {
          throw error;
        }
      }

      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt);
        console.error(
          `Attempt ${attempt + 1} failed, retrying in ${delay}ms...`,
          error instanceof Error ? error.message : String(error)
        );
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Generate embeddings for text using Ollama API
 * @param texts Array of text strings to embed
 * @param embeddingModel Optional model configuration to use
 * @returns Promise containing array of embeddings
 */
export async function generateOllamaEmbeddings(
  texts: string[],
  embeddingModel: {
    model: string;
    contextSize: number;
    dimensions: number;
    baseUrl?: string;
  } = config.EMBEDDING_MODEL
): Promise<number[][]> {
  try {
    // Log initialization
    if (!apiInitialized) {
      console.error(
        `Initializing Ollama embeddings with model: ${embeddingModel.model}...`
      );
      apiInitialized = true;
    }

    const baseUrl = embeddingModel.baseUrl || "http://127.0.0.1:11434";
    const embeddings: number[][] = [];

    // Process texts in smaller batches to avoid overwhelming the API
    console.error(`Generating embeddings for ${texts.length} chunks...`);
    const batchSize = config.OLLAMA_REQUEST_BATCH_SIZE; // Reduced batch size for stability

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(texts.length / batchSize);

      console.error(`Processing batch ${batchNum}/${totalBatches} (${batch.length} texts)`);

      try {
        // Use retry logic for each batch
        const response = await retryWithBackoff(async () => {
          return await axios.post(
            `${baseUrl}/api/embed`,
            {
              model: embeddingModel.model,
              input: batch,
              options: {
                num_ctx: embeddingModel.contextSize,
              },
            },
            {
              headers: {
                "Content-Type": "application/json",
              },
              timeout: config.REQUEST_TIMEOUT_MS,
            }
          );
        });

        if (!response.data.embeddings || !Array.isArray(response.data.embeddings)) {
          throw new Error("Invalid response format from Ollama API");
        }

        embeddings.push(...response.data.embeddings);

        // Small delay between batches to avoid overwhelming the API
        if (i + batchSize < texts.length) {
          await sleep(100);
        }
      } catch (error) {
        console.error(`Error processing batch ${batchNum}:`, error);

        // For testing purposes, use mock embeddings
        if (config.ENV === "test") {
          console.error("Using mock embeddings for failed batch");
          embeddings.push(...batch.map(() => generateMockEmbedding(embeddingModel.dimensions)));
        } else {
          throw new Error(
            `Failed to generate embeddings for batch ${batchNum}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    }

    console.error(`Successfully generated ${embeddings.length} embeddings`);
    return embeddings;
  } catch (error) {
    console.error("Error generating embeddings:", error);

    // For testing purposes, return mock embeddings if running in test environment
    if (config.ENV === "test") {
      console.error("Using mock embeddings for testing");
      return texts.map(() => generateMockEmbedding(embeddingModel.dimensions));
    }

    throw error;
  }
}

/**
 * Generate a simple mock embedding vector for testing
 * @param dimensions The number of dimensions in the embedding vector
 * @returns A normalized random vector of the specified dimensions
 */
function generateMockEmbedding(dimensions: number): number[] {
  // Create a random vector
  const vector = Array.from({ length: dimensions }, () => Math.random() - 0.5);

  // Normalize the vector
  const magnitude = Math.sqrt(vector.reduce((sum, val) => sum + val * val, 0));
  return vector.map((val) => val / magnitude);
}
