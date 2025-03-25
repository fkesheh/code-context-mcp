import { z } from "zod";
import { simpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import dbInterface from "../utils/db.js";
import {
  cloneRepository,
  getRepositoryFiles,
  getDefaultBranch,
} from "../utils/gitUtils.js";
import { extensionToSplitter, splitDocument } from "../utils/codeSplitter.js";
import { generateOllamaEmbeddings } from "../utils/ollamaEmbeddings.js";
import { createFilePatternCondition } from "../utils/filePatternMatcher.js";
import config from "../config.js";

// Define input schemas for tools
export const QueryRepoSchema = z.object({
  repoUrl: z.string().describe("GitHub repository URL"),
  branch: z
    .string()
    .optional()
    .describe("Branch name to query (defaults to repository's default branch)"),
  query: z.string().describe("Search query"),
  keywords: z
    .array(z.string())
    .optional()
    .describe(
      "Optional array of keywords to filter results (results must contain at least one keyword)"
    ),
  filePatterns: z
    .array(z.string())
    .optional()
    .describe(
      "Optional array of glob patterns to filter files (e.g. '**/*.ts', 'src/*.js')"
    ),
  excludePatterns: z
    .array(z.string())
    .optional()
    .describe(
      "Optional array of glob patterns to exclude files (e.g. '**/node_modules/**', '**/dist/**')"
    ),
  limit: z.number().optional().describe("Maximum number of results to return"),
  _meta: z
    .object({
      progressToken: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});

// Define chunk interface
interface Chunk {
  content: string;
  chunkNumber: number;
  tokenCount: number;
}

export interface ProgressNotifier {
  sendProgress: (progress: number, total: number) => Promise<void>;
}

export async function queryRepo(
  input: z.infer<typeof QueryRepoSchema>,
  progressNotifier?: ProgressNotifier
) {
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
      query,
      limit,
      keywords,
      filePatterns,
      excludePatterns,
    } = input;
    const progressToken = input._meta?.progressToken;

    // Validate required parameters
    if (!repoUrl || !query) {
      console.error(`[queryRepo] Error: Missing required parameters`);
      return {
        error: {
          message: "Required parameters (repoUrl, query) are missing",
        },
      };
    }

    const reposDir = config.REPO_CACHE_DIR;

    // If branch is not specified, get the default branch from the repository
    let actualBranch = branch || "";
    if (!branch) {
      console.error(`[queryRepo] Branch not specified, getting default branch`);

      // Extract owner and repo from URL
      const urlMatch = repoUrl.match(
        /github\.com[:\/]([^\/]+)\/([^\/\.]+)(\.git)?$/
      );
      if (!urlMatch) {
        console.error(`[queryRepo] Error: Could not parse repository URL`);
      return {
        error: {
          message: "Invalid repository URL format",
        },
      };
    }

      const [, owner, repo] = urlMatch;
      try {
        // Get the default branch
        console.error(
          `[queryRepo] Getting default branch for ${owner}/${repo}`
        );
        actualBranch = await getDefaultBranch(owner, repo);
        console.error(`[queryRepo] Using default branch: ${actualBranch}`);
      } catch (error) {
        console.error(`[queryRepo] Error getting default branch:`, error);
        // Fallback to 'main' if we can't determine the default branch
        actualBranch = "main";
        console.error(`[queryRepo] Falling back to branch: ${actualBranch}`);
      }
    }

    console.error(
      `[queryRepo] Cloning repository: ${repoUrl}, branch: ${actualBranch}`
    );
    const repoLocalPath = await cloneRepository(repoUrl, reposDir);
    console.error(
      `[queryRepo] Repository cloned to: ${repoLocalPath} (${
        Date.now() - startTime
      }ms)`
    );

    // Extract repo name from URL
    const repoName = path.basename(repoUrl, ".git");

    // Check if repo exists in database
    console.error(
      `[queryRepo] Checking if repo exists in database: ${repoName}`
    );
    const repoExists = dbInterface.get(
      "SELECT id FROM repository WHERE name = ?",
      repoName
    );

    let repoId;
    if (repoExists) {
      repoId = repoExists.id;
      console.error(
        `[queryRepo] Repository found in database with ID: ${repoId}`
      );
    } else {
      // Register repository
      console.error(`[queryRepo] Registering new repository: ${repoName}`);
      const result = dbInterface.run(
        "INSERT INTO repository (name, path) VALUES (?, ?)",
        [repoName, repoLocalPath]
      );
      repoId = result.lastInsertRowid;
      console.error(`[queryRepo] Repository registered with ID: ${repoId}`);
    }

    // Get the latest commit SHA
    console.error(`[queryRepo] Checking out branch: ${actualBranch}`);
    const git = simpleGit(repoLocalPath);
    // Ensure actualBranch is not undefined for checkout and revparse
    if (!actualBranch) {
      actualBranch = "main"; // Fallback to main if somehow still undefined
    }
    await git.checkout(actualBranch);
    const latestCommit = await git.revparse(actualBranch);
    console.error(`[queryRepo] Latest commit SHA: ${latestCommit}`);

    // Check if branch exists and has the same commit SHA
    console.error(`[queryRepo] Checking if branch exists in database`);
    const branchExists = dbInterface.get(
      "SELECT id, last_commit_sha FROM branch WHERE name = ? AND repository_id = ?",
      [actualBranch, repoId]
    );

    let branchId;
    let needsUpdate = false;

    if (branchExists) {
      branchId = branchExists.id;
      console.error(
        `[queryRepo] Branch found in database with ID: ${branchId}`
      );
      // Only process files if the commit has changed
      if (branchExists.last_commit_sha !== latestCommit) {
        needsUpdate = true;
        console.error(
          `[queryRepo] Commit SHA changed, updating branch: ${branchId}`
        );
        // Update branch commit SHA
        dbInterface.run(
          "UPDATE branch SET last_commit_sha = ?, status = 'pending' WHERE id = ?",
          [latestCommit, branchId]
        );
      } else {
        console.error(`[queryRepo] Commit SHA unchanged, skipping update`);
      }
    } else {
      // Register the branch
      console.error(`[queryRepo] Registering new branch: ${actualBranch}`);
      const result = dbInterface.run(
        "INSERT INTO branch (name, repository_id, last_commit_sha, status) VALUES (?, ?, ?, 'pending')",
        [actualBranch, repoId, latestCommit]
      );
      branchId = result.lastInsertRowid;
      needsUpdate = true;
      console.error(`[queryRepo] Branch registered with ID: ${branchId}`);
    }

    // Process the repository files if needed
    if (needsUpdate) {
      console.error(
        `[queryRepo] Processing repository files (${Date.now() - startTime}ms)`
      );
      // Get all files in the repository
      const { files } = await getRepositoryFiles(repoLocalPath, actualBranch);
      console.error(`[queryRepo] Found ${files.length} files in repository`);

      // Define transaction function
      console.error(`[queryRepo] Starting file database transaction`);
      const processFiles = (db: any) => {
        // Get existing files to compare
        const existingFiles = db
          .prepare(
            `SELECT f.id, f.path, f.sha FROM file f
                 JOIN branch_file_association bfa ON f.id = bfa.file_id
                 WHERE bfa.branch_id = ?`
          )
          .all(branchId);
        console.error(
          `[queryRepo] Found ${existingFiles.length} existing files in database`
        );

        const existingFileMap = new Map();
        for (const file of existingFiles) {
          existingFileMap.set(file.path, file);
        }

        // Track files that need processing
        const filesToProcess: any[] = [];

        // File counters for logging
        let newFiles = 0;
        let updatedFiles = 0;
        let unchangedFiles = 0;
        let removedFiles = 0;

        // Process each file
        for (const file of files) {
          const existingFile = existingFileMap.get(file.path);
          existingFileMap.delete(file.path); // Remove from map to track what's left later

          if (!existingFile) {
            // New file
            newFiles++;
            const result = db
              .prepare(
                "INSERT INTO file (repository_id, path, sha, name, status) VALUES (?, ?, ?, ?, 'pending')"
              )
              .run(repoId, file.path, file.sha, file.name);

            const fileId = result.lastInsertRowid;

            // Associate with branch
            db.prepare(
              "INSERT INTO branch_file_association (branch_id, file_id) VALUES (?, ?)"
            ).run(branchId, fileId);

            filesToProcess.push({
              id: fileId,
              path: file.path,
              name: file.name,
            });
          } else if (existingFile.sha !== file.sha) {
            // Updated file - SHA changed
            updatedFiles++;
            db.prepare(
              "UPDATE file SET sha = ?, status = 'pending' WHERE id = ?"
            ).run(file.sha, existingFile.id);

            filesToProcess.push({
              id: existingFile.id,
              path: file.path,
              name: file.name,
            });
          } else {
            // Unchanged file
            unchangedFiles++;
          }
        }

        // Remove files that no longer exist in the branch
        for (const [path, file] of existingFileMap.entries()) {
          removedFiles++;
          db.prepare(
            "DELETE FROM branch_file_association WHERE branch_id = ? AND file_id = ?"
          ).run(branchId, file.id);

          // If no other branches reference this file, delete it and its chunks
          const fileStillInUse = db
            .prepare(
              "SELECT 1 FROM branch_file_association WHERE file_id = ? LIMIT 1"
            )
            .get(file.id);

          if (!fileStillInUse) {
            // Delete chunks first
            db.prepare("DELETE FROM file_chunk WHERE file_id = ?").run(file.id);
            // Then delete the file
            db.prepare("DELETE FROM file WHERE id = ?").run(file.id);
          }
        }

        console.error(
          `[queryRepo] Files summary: ${newFiles} new, ${updatedFiles} updated, ${unchangedFiles} unchanged, ${removedFiles} removed`
        );
        return filesToProcess;
      };

      // Execute the transaction
      console.error(`[queryRepo] Executing file processing transaction`);
      const filesToProcess = dbInterface.transaction((db) => processFiles(db));
      console.error(
        `[queryRepo] Transaction completed, processing ${
          filesToProcess.length
        } files (${Date.now() - startTime}ms)`
      );

      // Limit the number of files processed to avoid timeouts
      // This might need adjustment based on actual performance
      const MAX_FILES_TO_PROCESS = 1000000;
      const limitedFiles = filesToProcess.slice(0, MAX_FILES_TO_PROCESS);

      if (limitedFiles.length < filesToProcess.length) {
        console.error(
          `[queryRepo] WARNING: Processing only ${limitedFiles.length} of ${filesToProcess.length} files to avoid timeout`
        );
      }

      // Process content and generate embeddings for new/updated files outside of transaction
      let processedFiles = 0;
      let totalChunks = 0;

      for (const file of limitedFiles) {
        try {
          console.error(
            `[queryRepo] Processing file ${processedFiles + 1}/${
              limitedFiles.length
            }: ${file.path}`
          );
          const filePath = path.join(repoLocalPath, file.path);
          if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, "utf-8");
            const extension = filePath.split(".").pop()?.toLowerCase();
            const splitterType = extension
              ? extensionToSplitter(extension)
              : "ignore";

            if (splitterType === "ignore") {
              continue;
            }

            console.error(
              `[queryRepo] Splitting file: ${file.path} with splitter type: ${splitterType}`
            );

            // Split the document into chunks
            const docChunks = await splitDocument(content, splitterType);
            console.error(
              `[queryRepo] Split file into ${docChunks.length} chunks`
            );

            // Convert Document objects to our Chunk interface
            const chunks: Chunk[] = docChunks.map((doc, index) => ({
              content: doc.pageContent,
              chunkNumber: index + 1,
              tokenCount: Math.ceil(doc.pageContent.length / 4), // Approximate token count
            }));

            // Delete existing chunks for this file
            console.error(
              `[queryRepo] Deleting existing chunks for file: ${file.id}`
            );
            dbInterface.run(
              "DELETE FROM file_chunk WHERE file_id = ?",
              file.id
            );

            // Process batches of chunks for embeddings
            const chunkBatches: Chunk[][] = [];
            for (let i = 0; i < chunks.length; i += 20) {
              chunkBatches.push(chunks.slice(i, i + 20));
            }
            console.error(
              `[queryRepo] Created ${chunkBatches.length} batches of chunks`
            );

            for (
              let batchIndex = 0;
              batchIndex < chunkBatches.length;
              batchIndex++
            ) {
              console.error(
                `[queryRepo] Processing batch ${batchIndex + 1}/${
                  chunkBatches.length
                }`
              );
              const batch = chunkBatches[batchIndex];
              const chunkContents = batch.map((c: Chunk) => c.content);

              // Generate embeddings for chunks
              console.error(
                `[queryRepo] Generating embeddings for ${batch.length} chunks`
              );
              const embeddingStartTime = Date.now();
              const embeddings = await generateOllamaEmbeddings(chunkContents);
              console.error(
                `[queryRepo] Generated embeddings in ${
                  Date.now() - embeddingStartTime
                }ms`
              );

              // Store chunks with embeddings in transaction for better performance
              console.error(`[queryRepo] Storing chunks with embeddings`);
              dbInterface.transaction((db) => {
                const insertChunkStmt = db.prepare(`INSERT INTO file_chunk (
                        file_id, content, chunk_number, embedding, model_version, token_count
                      ) VALUES (?, ?, ?, ?, ?, ?)`);
                for (let i = 0; i < batch.length; i++) {
                  const chunk = batch[i];
                  const embedding = JSON.stringify(embeddings[i]);

                  insertChunkStmt.run(
                    file.id,
                    chunk.content,
                    chunk.chunkNumber,
                    embedding,
                    config.EMBEDDING_MODEL.model,
                    chunk.tokenCount
                  );
                }
              });

              totalChunks += batch.length;

              // Send progress notification
              if (progressNotifier) {
                const progress = (processedFiles + 1) / limitedFiles.length;
                await progressNotifier.sendProgress(progress, 1);
              }
            }

            // Update file status
            console.error(
              `[queryRepo] Updating file status to done: ${file.id}`
            );
            dbInterface.run(
              "UPDATE file SET status = 'done' WHERE id = ?",
              file.id
            );

            processedFiles++;
          } else {
            console.error(`[queryRepo] File does not exist: ${filePath}`);
          }
        } catch (error) {
          console.error(
            `[queryRepo] Error processing file ${file.path}:`,
            error
          );
          dbInterface.run(
            "UPDATE file SET status = 'fetched' WHERE id = ?",
            file.id
          );
        }
      }

      console.error(
        `[queryRepo] Processed ${processedFiles} files with ${totalChunks} total chunks (${
          Date.now() - startTime
        }ms)`
      );

      // Update branch status based on whether we processed all files or just a subset
      if (limitedFiles.length < filesToProcess.length) {
        console.error(
          `[queryRepo] Setting branch status to 'files_processed' due to processing limit`
        );
        dbInterface.run(
          "UPDATE branch SET status = 'files_processed' WHERE id = ?",
          branchId
        );
      } else {
        console.error(
          `[queryRepo] Setting branch status to 'embeddings_generated'`
        );
        dbInterface.run(
          "UPDATE branch SET status = 'embeddings_generated' WHERE id = ?",
          branchId
        );
      }
    }

    // Generate embedding for the query
    console.error(`[queryRepo] Generating embedding for query: "${query}"`);
    const queryEmbedStart = Date.now();
    const [queryEmbedding] = await generateOllamaEmbeddings([query]);
    const queryEmbeddingStr = JSON.stringify(queryEmbedding);
    console.error(
      `[queryRepo] Generated query embedding in ${
        Date.now() - queryEmbedStart
      }ms`
    );

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
      [queryEmbeddingStr, branchId, effectiveLimit]
    );
    console.error(
      `[queryRepo] Search completed in ${Date.now() - searchStart}ms, found ${
        results.length
      } results`
    );

    // Filter results by keywords if provided
    let filteredResults = results;
    if (keywords && keywords.length > 0) {
      console.error(
        `[queryRepo] Filtering results by keywords: ${keywords.join(", ")}`
      );
      const keywordFilterStart = Date.now();

      // Convert keywords to lowercase for case-insensitive matching
      const lowercaseKeywords = keywords.map((kw) => kw.toLowerCase());

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

    const totalTime = Date.now() - startTime;
    console.error(`[queryRepo] Tool completed in ${totalTime}ms`);

    return {
      output: {
        success: true,
        repoUrl,
        branch: actualBranch,
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
  }
}
