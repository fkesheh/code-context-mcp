import { z } from "zod";
import dbInterface from "../utils/db.js";
import { generateOllamaEmbeddings } from "../utils/ollamaEmbeddings.js";
import { ProgressNotifier } from "../utils/types.js";
import config from "../config.js";

// Define input schema for embedFiles
export const EmbedFilesSchema = z.object({
  repoLocalPath: z.string().describe("Local path to the cloned repository"),
  branchId: z.number().describe("Branch ID in the database"),
  _meta: z
    .object({
      progressToken: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

// Define chunk interface
interface Chunk {
  id: number;
  content: string;
  file_id: number;
}

export async function embedFiles(
  input: z.infer<typeof EmbedFilesSchema>,
  progressNotifier?: ProgressNotifier
) {
  try {
    console.error(
      `[embedFiles] Starting with parameters: ${JSON.stringify(input)}`
    );

    // Check if input is defined
    if (!input) {
      console.error(`[embedFiles] Error: Input parameters are undefined`);
      return {
        error: {
          message: "Input parameters are required for embedFiles tool",
        },
      };
    }

    const startTime = Date.now();
    const { branchId } = input;

    // First check if the branch exists
    const branchExists = dbInterface.get(
      "SELECT id, status FROM branch WHERE id = ?",
      branchId
    );

    if (!branchExists) {
      console.error(`[embedFiles] Error: Branch with ID ${branchId} does not exist`);
      return {
        error: {
          message: `Branch with ID ${branchId} does not exist`,
        },
      };
    }

    // Check if there are any files associated with this branch
    const fileCount = dbInterface.get(
      "SELECT COUNT(*) as count FROM branch_file_association WHERE branch_id = ?",
      branchId
    );

    if (!fileCount || fileCount.count === 0) {
      console.error(`[embedFiles] No files found for branch ${branchId}`);
      // Still update the branch status
      console.error(`[embedFiles] Setting branch status to 'embeddings_generated'`);
      dbInterface.run(
        "UPDATE branch SET status = 'embeddings_generated' WHERE id = ?",
        branchId
      );
      return { success: true, chunksProcessed: 0 };
    }

    // Get all chunks that need embeddings
    console.error(`[embedFiles] Finding chunks that need embeddings for branch ${branchId}`);
    const chunks = dbInterface.all(
      `SELECT fc.id, fc.content, f.id as file_id
       FROM file_chunk fc
       JOIN file f ON fc.file_id = f.id
       JOIN branch_file_association bfa ON f.id = bfa.file_id
       WHERE bfa.branch_id = ?
       AND fc.embedding IS NULL`,
      branchId
    );

    if (chunks.length === 0) {
      console.error(`[embedFiles] No chunks need embeddings, skipping`);
      // Update branch status even when no chunks need embeddings
      console.error(`[embedFiles] Setting branch status to 'embeddings_generated'`);
      dbInterface.run(
        "UPDATE branch SET status = 'embeddings_generated' WHERE id = ?",
        branchId
      );
      
      if (progressNotifier) {
        await progressNotifier.sendProgress(1, 1);
      }
      return { success: true, chunksProcessed: 0 };
    }

    console.error(`[embedFiles] Found ${chunks.length} chunks that need embeddings`);

    let processedChunks = 0;
    const totalChunks = chunks.length;

    const BATCH_SIZE = 100

    // Process chunks in batches of BATCH_SIZE
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      console.error(
        `[embedFiles] Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(totalChunks/BATCH_SIZE)}`
      );

      // Generate embeddings for the batch
      const chunkContents = batch.map((chunk: Chunk) => chunk.content);
      console.error(`[embedFiles] Generating embeddings for ${batch.length} chunks`);
      const embeddingStartTime = Date.now();
      const embeddings = await generateOllamaEmbeddings(chunkContents);
      console.error(
        `[embedFiles] Generated embeddings in ${Date.now() - embeddingStartTime}ms`
      );

      // Store embeddings in transaction
      console.error(`[embedFiles] Storing embeddings`);
      dbInterface.transaction((db) => {
        const updateStmt = db.prepare(
          `UPDATE file_chunk 
           SET embedding = ?, model_version = ? 
           WHERE id = ?`
        );
        for (let j = 0; j < batch.length; j++) {
          const chunk = batch[j];
          const embedding = JSON.stringify(embeddings[j]);
          updateStmt.run(embedding, config.EMBEDDING_MODEL.model, chunk.id);
        }
      });

      processedChunks += batch.length;

      // Update progress
      if (progressNotifier) {
        const progress = processedChunks / totalChunks;
        await progressNotifier.sendProgress(progress, 1);
      }
    }

    // Update branch status
    console.error(`[embedFiles] Setting branch status to 'embeddings_generated'`);
    dbInterface.run(
      "UPDATE branch SET status = 'embeddings_generated' WHERE id = ?",
      branchId
    );

    console.error(
      `[embedFiles] Processed ${processedChunks} chunks in ${
        Date.now() - startTime
      }ms`
    );

    return { 
      success: true, 
      chunksProcessed: processedChunks 
    };
  } catch (error) {
    console.error(`[embedFiles] Error executing tool:`, error);
    return {
      error: {
        message: `Error executing embedFiles tool: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}
