import { z } from "zod";
import dbInterface from "../utils/db.js";
import { generateOllamaEmbeddings } from "../utils/ollamaEmbeddings.js";
import { createFilePatternCondition } from "../utils/filePatternMatcher.js";
import { ProgressNotifier } from "../utils/types.js";
import { ingestBranch } from "./ingestBranch.js";
import { processFiles } from "./processFiles.js";

// Define input schemas for tools
export const QueryRepoSchema = z.object({
  repoUrl: z.string().describe("GitHub repository URL"),
  branch: z
    .string()
    .optional()
    .describe("Branch name to query (defaults to repository's default branch)"),
  semanticSearch: z.string().describe("Query for semantic search. This search is not exact, it will try to find the most relevant files, it doesn't accept file: or path: prefixes."),
  keywordsSearch: z
    .array(z.string())
    .describe(
      "Search to the files that contain at least one of the keywords in this list. Leave empty to disable. This can work in conjunction with the semantic search."
    ),
  filePatterns: z
    .array(z.string())
    .describe(
      "Array of glob patterns to filter files (e.g. '**/*.ts', 'src/*.js'). Use it for a more effective search or to target specific files for example 'somefile.tsx'. Leave empty to disable"
    ),
  excludePatterns: z
    .array(z.string())
    .optional()
    .describe(
      "Array of glob patterns to exclude files (e.g. '**/node_modules/**', '**/dist/**'). Use it to exclude files that are not relevant to the search. Leave empty to disable"
    ),
  limit: z.number().optional().describe("Maximum number of results to return"),
  _meta: z
    .object({
      progressToken: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

// Helper function to create a heartbeat progress notifier
function createHeartbeatNotifier(originalNotifier?: ProgressNotifier, heartbeatMs: number = 2000): {
  notifier: ProgressNotifier;
  stopHeartbeat: () => void;
} {
  if (!originalNotifier) {
    return {
      notifier: {
        sendProgress: async () => {} // No-op if no original notifier
      },
      stopHeartbeat: () => {}
    };
  }
  
  let currentProgress = 0;
  let currentMax = 1;
  let isActive = true;
  let lastUpdate = Date.now();
  
  // Heartbeat interval
  const intervalId = setInterval(async () => {
    if (!isActive) return;
    
    // Only send if it's been more than heartbeatMs since the last update
    if (Date.now() - lastUpdate >= heartbeatMs) {
      console.error(`[queryRepo] Heartbeat progress: ${currentProgress}/${currentMax}`);
      await originalNotifier.sendProgress(currentProgress, currentMax);
    }
  }, heartbeatMs);
  
  return {
    notifier: {
      sendProgress: async (progress: number, max: number) => {
        currentProgress = progress;
        currentMax = max;
        lastUpdate = Date.now();
        await originalNotifier.sendProgress(progress, max);
      }
    },
    stopHeartbeat: () => {
      isActive = false;
      clearInterval(intervalId);
    }
  };
}

export async function queryRepo(
  input: z.infer<typeof QueryRepoSchema>,
  progressNotifier?: ProgressNotifier
) {
  // Create heartbeat notifier that will send regular updates
  const { notifier: heartbeatNotifier, stopHeartbeat } = createHeartbeatNotifier(progressNotifier);
  
  try {
    console.error(
      `[queryRepo] Starting with parameters: ${JSON.stringify(input)}`
    );

    // Check if input is defined
    if (!input) {
      console.error(`[queryRepo] Error: Input parameters are undefined`);
      return {
        error: {
          message: "Input parameters are required for queryRepo tool",
        },
      };
    }

    const startTime = Date.now();

    const {
      repoUrl,
      branch,
      semanticSearch: semanticSearchInput,
      keywordsSearch,
      limit,
      filePatterns,
      excludePatterns,
    } = input;

    // Validate required parameters
    if (!repoUrl ||(!semanticSearchInput && !keywordsSearch)) {
      console.error(`[queryRepo] Error: Missing required parameters`);
      return {
        error: {
          message: "Required parameters (repoUrl, semanticSearch or keywordsSearch) are missing",
        },
      };
    }

    let semanticSearch = semanticSearchInput;
    if(!semanticSearchInput) {
      semanticSearch = keywordsSearch.join(" ");
    }

    // Initialize progress at start
    await heartbeatNotifier.sendProgress(0.05, 1);

    // Step 1: Ingest the branch (25% of progress)
    console.error(`[queryRepo] Ingesting branch: ${repoUrl}, ${branch || 'default'}`);
    const branchResult = await ingestBranch(
      { 
        repoUrl, 
        branch
      }, 
      undefined // Don't pass progress notifier to individual tools
    );

    // Update progress after branch ingestion
    await heartbeatNotifier.sendProgress(0.25, 1);

    // Check for error
    if ('error' in branchResult) {
      console.error(`[queryRepo] Error in ingestBranch:`, branchResult.error);
      return { error: branchResult.error };
    }

    const branchData = branchResult;

    // Step 2: Process files if needed (50% of progress)
    console.error(`[queryRepo] Processing files for branch: ${branchData.branchId}`);
    const filesResult = await processFiles(
      {
        repoLocalPath: branchData.repoLocalPath,
        repoId: branchData.repoId,
        branchId: branchData.branchId,
        actualBranch: branchData.actualBranch,
        needsUpdate: branchData.needsUpdate
      },
      undefined // Don't pass progress notifier to individual tools
    );

    // Update progress after file processing
    await heartbeatNotifier.sendProgress(0.5, 1);

    // Check for error
    if ('error' in filesResult) {
      console.error(`[queryRepo] Error in processFiles:`, filesResult.error);
      return { error: filesResult.error };
    }

    // Generate embedding for the query
    console.error(`[queryRepo] Generating embedding for query: "${semanticSearch}"`);
    const queryEmbedStart = Date.now();
    const [queryEmbedding] = await generateOllamaEmbeddings([semanticSearch]);
    const queryEmbeddingStr = JSON.stringify(queryEmbedding);
    console.error(
      `[queryRepo] Generated query embedding in ${
        Date.now() - queryEmbedStart
      }ms`
    );

    // Update progress after query embedding
    await heartbeatNotifier.sendProgress(0.6, 1);

    // Search for similar chunks using SQLite's JSON functions for vector similarity
    console.error(
      `[queryRepo] Searching for similar chunks with limit: ${limit}`
    );
    const searchStart = Date.now();
    // Use a default limit of 10 if undefined
    const effectiveLimit = limit === undefined ? 10 : limit;

    // Create SQL condition for file pattern filtering
    const filePatternCondition = createFilePatternCondition(
      filePatterns,
      excludePatterns
    );

    const results = dbInterface.all(
      `
      SELECT fc.content, f.path, fc.chunk_number,
             (SELECT  (SELECT SUM(json_extract(value, '$') * json_extract(?, '$[' || key || ']'))
                        FROM json_each(fc.embedding)
                        GROUP BY key IS NOT NULL)
              )/${queryEmbedding.length} as similarity
      FROM file_chunk fc
      JOIN file f ON fc.file_id = f.id
      JOIN branch_file_association bfa ON f.id = bfa.file_id
      WHERE bfa.branch_id = ?
      AND fc.embedding IS NOT NULL
      ${filePatternCondition}
      ORDER BY similarity DESC
      LIMIT ?
    `,
      [queryEmbeddingStr, branchData.branchId, effectiveLimit]
    );
    console.error(
      `[queryRepo] Search completed in ${Date.now() - searchStart}ms, found ${
        results.length
      } results`
    );

    // Update progress after initial search
    await heartbeatNotifier.sendProgress(0.7, 1);

    // If no results found, check if embeddings need to be generated
    if (results.length === 0) {
      console.error(`[queryRepo] No results found, checking if embeddings need to be generated`);
      
      // Check if there are any chunks without embeddings
      const chunksWithoutEmbeddings = dbInterface.get(
        `SELECT COUNT(*) as count 
         FROM file_chunk fc
         JOIN file f ON fc.file_id = f.id
         JOIN branch_file_association bfa ON f.id = bfa.file_id
         WHERE bfa.branch_id = ?
         AND fc.embedding IS NULL`,
        branchData.branchId
      );

      if (chunksWithoutEmbeddings && chunksWithoutEmbeddings.count > 0) {
        console.error(`[queryRepo] Found ${chunksWithoutEmbeddings.count} chunks without embeddings, generating them`);
        
        // Import embedFiles function
        const { embedFiles } = await import('./embedFiles.js');
        
        // Generate embeddings (75-90% of progress)
        await heartbeatNotifier.sendProgress(0.75, 1);
        
        // Generate embeddings
        const embedResult = await embedFiles(
          {
            repoLocalPath: branchData.repoLocalPath,
            branchId: branchData.branchId
          },
          undefined // Don't pass progress notifier to individual tools
        );

        // Update progress after embedding generation
        await heartbeatNotifier.sendProgress(0.9, 1);

        if ('error' in embedResult) {
          console.error(`[queryRepo] Error generating embeddings:`, embedResult.error);
          return { error: embedResult.error };
        }

        // Try searching again after generating embeddings
        console.error(`[queryRepo] Retrying search after generating embeddings`);
        const retryResults = dbInterface.all(
          `
          SELECT fc.content, f.path, fc.chunk_number,
                 (SELECT  (SELECT SUM(json_extract(value, '$') * json_extract(?, '$[' || key || ']'))
                            FROM json_each(fc.embedding)
                            GROUP BY key IS NOT NULL)
                  ) as similarity
          FROM file_chunk fc
          JOIN file f ON fc.file_id = f.id
          JOIN branch_file_association bfa ON f.id = bfa.file_id
          WHERE bfa.branch_id = ?
          AND fc.embedding IS NOT NULL
          ${filePatternCondition}
          ORDER BY similarity DESC
          LIMIT ?
        `,
          [queryEmbeddingStr, branchData.branchId, effectiveLimit]
        );

        console.error(
          `[queryRepo] Retry search completed, found ${retryResults.length} results`
        );
        results.push(...retryResults);
      }
    }

    // Filter results by keywords if provided
    let filteredResults = results;
    if (keywordsSearch && keywordsSearch.length > 0) {
      console.error(
        `[queryRepo] Filtering results by keywords: ${keywordsSearch.join(", ")}`
      );
      const keywordFilterStart = Date.now();

      // Convert keywords to lowercase for case-insensitive matching
      const lowercaseKeywords = keywordsSearch.map((kw) => kw.trim().toLowerCase());

      filteredResults = results.filter((result: { content: string }) => {
        const content = result.content.toLowerCase();
        // Check if the content contains at least one of the keywords
        return lowercaseKeywords.some((keyword) => content.includes(keyword));
      });

      console.error(
        `[queryRepo] Keyword filtering completed in ${
          Date.now() - keywordFilterStart
        }ms, filtered from ${results.length} to ${
          filteredResults.length
        } results`
      );
    }

    // Update progress to completion
    await heartbeatNotifier.sendProgress(1, 1);

    const totalTime = Date.now() - startTime;
    console.error(`[queryRepo] Tool completed in ${totalTime}ms`);

    return {
      output: {
        success: true,
        repoUrl,
        branch: branchData.actualBranch,
        processingTimeMs: totalTime,
        results: filteredResults.map((result: any) => ({
          filePath: result.path,
          chunkNumber: result.chunk_number,
          content: result.content,
          similarity: result.similarity,
        })),
      },
    };
  } catch (error) {
    console.error(`[queryRepo] Error executing tool:`, error);
    return {
      error: {
        message: `Error executing queryRepo tool: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  } finally {
    // Always stop the heartbeat when done
    stopHeartbeat();
  }
} 