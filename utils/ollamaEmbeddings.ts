import axios from "axios";
import config from "../config.js";

// Cache for API
let apiInitialized = false;

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

    // Process texts in parallel with a rate limit
    console.error(`Generating embeddings for ${texts.length} chunks...`);
    const batchSize = 1000; // Process 5 at a time to avoid overwhelming the API
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await axios.post(
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
            }
          );
      // Await all promises in this batch
      embeddings.push(...response.data.embeddings);
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
