import { simpleGit } from "simple-git";
import fs from "fs";
import path from "path";
import db from "./db.js";
import { extensionToSplitter, splitDocument } from "./codeSplitter.js";
import config from "../config.js";
import { generateOllamaEmbeddings } from "./ollamaEmbeddings.js";

/**
 * Clone a git repository if it doesn't exist locally
 * @param repoUrl URL of the git repository
 * @param localPath Local path to clone to
 * @returns Path to the cloned repository
 */
export const cloneRepository = async (
  repoUrl: string,
  localPath: string
): Promise<string> => {
  // Extract repository name from URL
  const repoName = path.basename(repoUrl, ".git");
  const fullPath = path.join(localPath, repoName);

  // Check if repository already exists
  if (fs.existsSync(fullPath)) {
    console.error(`Repository already exists at ${fullPath}`);
    return fullPath;
  }

  // Clone the repository
  console.error(`Cloning repository ${repoUrl} to ${fullPath}`);
  const git = simpleGit();
  await git.clone(repoUrl, fullPath);

  return fullPath;
};

/**
 * Register a repository in the database
 * @param repoPath Path to the local repository
 * @returns Repository ID
 */
export const registerRepository = (repoPath: string): number => {
  const repoName = path.basename(repoPath);

  // Insert repository into database
  const result = db.run(
    "INSERT INTO repository (name, path) VALUES (:name, :path) ON CONFLICT(path) DO UPDATE SET last_updated = CURRENT_TIMESTAMP RETURNING id",
    { name: repoName, path: repoPath }
  );

  // If no id was returned, get it
  if (!result.lastInsertRowid) {
    const repo = db.get("SELECT id FROM repository WHERE path = :path", {
      path: repoPath,
    }) as { id: number };
    return repo.id;
  }

  return result.lastInsertRowid as number;
};

/**
 * Register a branch in the database
 * @param branchName Name of the branch
 * @param repoId Repository ID
 * @param commitSha Latest commit SHA
 * @returns Branch ID
 */
export const registerBranch = (
  branchName: string,
  repoId: number,
  commitSha: string
): number => {
  // Insert branch into database
  const result = db.run(
    `INSERT INTO branch (name, repository_id, last_commit_sha, status)
     VALUES (:name, :repoId, :commitSha, 'pending')
     ON CONFLICT(name, repository_id) DO UPDATE
     SET last_commit_sha = :commitSha,
         status = CASE
                    WHEN last_commit_sha <> :commitSha THEN 'pending'
                    ELSE status
                  END
     RETURNING id`,
    { name: branchName, repoId, commitSha }
  );

  // If no id was returned, get it
  if (!result.lastInsertRowid) {
    const branch = db.get(
      "SELECT id FROM branch WHERE name = :name AND repository_id = :repoId",
      { name: branchName, repoId }
    ) as { id: number };
    return branch.id;
  }

  return result.lastInsertRowid as number;
};

interface RepositoryFile {
  path: string;
  name: string;
  sha: string;
}

interface RepositoryFilesResult {
  files: RepositoryFile[];
  commitSha: string;
}

/**
 * Get the files in a repository branch
 * @param repoPath Path to the repository
 * @param branchName Name of the branch
 * @returns List of files with their metadata
 */
export const getRepositoryFiles = async (
  repoPath: string,
  branchName: string
): Promise<RepositoryFilesResult> => {
  const git = simpleGit(repoPath);

  // Checkout the branch
  await git.checkout(branchName);

  // Get the latest commit SHA
  const latestCommit = await git.revparse([branchName]);

  // Get the file tree
  const files: RepositoryFile[] = [];

  // Use git ls-tree to get all files recursively
  const result = await git.raw(["ls-tree", "-r", branchName]);
  const stdout = result.toString();

  // Parse the output
  const lines = stdout.split("\n").filter((line) => line.trim() !== "");

  for (const line of lines) {
    // Format: <mode> <type> <object> <file>
    const [info, filePath] = line.split("\t");
    const [, , sha] = info.split(" ");

    if (filePath) {
      files.push({
        path: filePath,
        name: path.basename(filePath),
        sha,
      });
    }
  }

  return { files, commitSha: latestCommit };
};

/**
 * Process files for a branch
 * @param branchId Branch ID
 * @param repoId Repository ID
 * @param repoPath Path to the repository
 * @param branchName Name of the branch
 */
export const processRepositoryFiles = async (
  branchId: number,
  repoId: number,
  repoPath: string,
  branchName: string
): Promise<void> => {
  // Get files in the repository
  const { files, commitSha } = await getRepositoryFiles(repoPath, branchName);

  // Process each file
  db.transaction((db) => {
    for (const file of files) {
      // Insert file information
      const fileResult = db.run(
        `INSERT INTO file (repository_id, path, sha, name, status)
         VALUES (:repoId, :path, :sha, :name, :status)
         ON CONFLICT(repository_id, path, sha) DO NOTHING
         RETURNING id`,
        {
          repoId,
          path: file.path,
          sha: file.sha,
          name: file.name,
          status: "pending",
        }
      );

      let fileId;

      if (fileResult.lastInsertRowid) {
        fileId = fileResult.lastInsertRowid;
      } else {
        // Get the existing file ID
        const existingFile = db.get(
          "SELECT id FROM file WHERE repository_id = :repoId AND path = :path AND sha = :sha",
          {
            repoId,
            path: file.path,
            sha: file.sha,
          }
        ) as { id: number };

        fileId = existingFile.id;
      }

      // Associate file with branch
      db.run(
        "INSERT INTO branch_file_association (branch_id, file_id) VALUES (:branchId, :fileId) ON CONFLICT DO NOTHING",
        {
          branchId,
          fileId,
        }
      );

      // Update branch status
      db.run(
        "UPDATE branch SET last_commit_sha = :commitSha, status = :status WHERE id = :branchId",
        {
          commitSha,
          status: "files_processed",
          branchId,
        }
      );
    }
  });
};

interface PendingFile {
  id: number;
  path: string;
  sha: string;
}

interface FileChunk {
  id: number;
  chunk_number: number;
  content: string;
  file_id: number;
}

/**
 * Process file content and split into chunks
 * @param branchName Branch name
 * @param repoPath Repository path
 */
export const processFileContents = async (
  branchName: string,
  repoPath: string
): Promise<void> => {
  const git = simpleGit(repoPath);

  // Checkout the branch
  await git.checkout(branchName);

  // Get repository and branch IDs
  const repo = db.get("SELECT id FROM repository WHERE path = :path", {
    path: repoPath,
  }) as { id: number };
  const branch = db.get(
    "SELECT id FROM branch WHERE name = :name AND repository_id = :repoId",
    { name: branchName, repoId: repo.id }
  ) as { id: number };

  // Get all pending files for the branch
  const pendingFiles = db.all(
    `SELECT f.id, f.path, f.sha
     FROM file f
     JOIN branch_file_association bfa ON f.id = bfa.file_id
     WHERE f.status = 'pending' AND bfa.branch_id = :branchId`,
    { branchId: branch.id }
  ) as PendingFile[];

  for (const file of pendingFiles) {
    console.error(`Processing file: ${file.path}`);
    const extension = file.path.split(".").pop()?.toLowerCase();
    const splitType = extension ? extensionToSplitter(extension) : "ignore";

    if (splitType !== "ignore") {
      try {
        // Get file content
        const filePath = path.join(repoPath, file.path);

        // Skip if file doesn't exist (might have been deleted)
        if (!fs.existsSync(filePath)) {
          console.error(`File ${file.path} doesn't exist, skipping`);
          continue;
        }

        let content = fs.readFileSync(filePath, "utf-8");

        // Check for null bytes in the content
        if (content.includes("\0")) {
          console.error(
            `File ${file.path} contains null bytes. Removing them.`
          );
          content = content.replace(/\0/g, "");
        }

        // Check if the content is valid UTF-8
        try {
          new TextDecoder("utf-8", { fatal: true }).decode(
            new TextEncoder().encode(content)
          );
        } catch (e) {
          console.error(
            `File ${file.path} contains invalid UTF-8 characters. Replacing them.`
          );
          content = content.replace(/[^\x00-\x7F]/g, ""); // Remove non-ASCII characters
        }

        // Truncate content if it's too long
        const maxLength = 1000000; // Adjust this value based on your database column size
        if (content.length > maxLength) {
          console.error(
            `File ${file.path} content is too long. Truncating to ${maxLength} characters.`
          );
          content = content.substring(0, maxLength);
        }

        // Split the document
        const chunks = await splitDocument(file.path, content);

        // Store chunks in the database
        db.transaction((db) => {
          for (let i = 0; i < chunks.length; i++) {
            db.run(
              `INSERT INTO file_chunk (file_id, content, chunk_number)
               VALUES (:fileId, :content, :chunkNumber)
               ON CONFLICT(file_id, chunk_number) DO NOTHING`,
              {
                fileId: file.id,
                content: chunks[i].pageContent,
                chunkNumber: i + 1,
              }
            );
          }

          // Update file status to 'fetched'
          db.run("UPDATE file SET status = :status WHERE id = :fileId", {
            status: "fetched",
            fileId: file.id,
          });
        });
      } catch (error) {
        console.error(`Error processing file ${file.path}:`, error);
      }
    } else {
      // Update file status to 'done' for ignored files
      db.run("UPDATE file SET status = :status WHERE id = :fileId", {
        status: "done",
        fileId: file.id,
      });
    }
  }
};

/**
 * Generate embeddings for file chunks
 * @param branchName Branch name
 * @param repoPath Repository path
 */
export const generateEmbeddings = async (
  branchName: string,
  repoPath: string
): Promise<void> => {
  // Get repository ID
  const repo = db.get("SELECT id FROM repository WHERE path = :path", {
    path: repoPath,
  }) as { id: number };

  if (!repo) {
    throw new Error(`Repository not found at path ${repoPath}`);
  }

  // Get branch ID
  const branch = db.get(
    "SELECT id FROM branch WHERE name = :name AND repository_id = :repoId",
    { name: branchName, repoId: repo.id }
  ) as { id: number };

  if (!branch) {
    throw new Error(`Branch ${branchName} not found in repository`);
  }

  // Update branch status to processing
  db.run("UPDATE branch SET status = 'processing_embeddings' WHERE id = :id", {
    id: branch.id,
  });

  // Get chunks that need embeddings
  const chunks = db.all(
    `SELECT fc.id, fc.content 
     FROM file_chunk fc
     JOIN file f ON fc.file_id = f.id
     JOIN branch_file_association bfa ON f.id = bfa.file_id
     WHERE bfa.branch_id = :branchId
     AND fc.embedding IS NULL`,
    { branchId: branch.id }
  ) as { id: number; content: string }[];

  console.error(`Found ${chunks.length} chunks without embeddings`);

  // Process in batches
  for (let i = 0; i < chunks.length; i += config.BATCH_SIZE) {
    const batchChunks = chunks.slice(i, i + config.BATCH_SIZE);
    const batchTexts = batchChunks.map((chunk) => chunk.content);

    try {
      // Generate embeddings with HuggingFace
      const embeddings = await generateOllamaEmbeddings(batchTexts);

      // Update chunks with embeddings
      db.transaction((db) => {
        for (let j = 0; j < batchChunks.length; j++) {
          const chunkId = batchChunks[j].id;
          const embedding = JSON.stringify(embeddings[j]);
          db.run(
            `UPDATE file_chunk SET 
              embedding = :embedding,
              model_version = :modelVersion,
              token_count = :tokenCount,
              updated_at = :updatedAt
              WHERE id = :id`,
            {
              embedding,
              modelVersion: config.EMBEDDING_MODEL.model,
              tokenCount: batchTexts[j].length,
              updatedAt: new Date().toISOString(),
              id: chunkId,
            }
          );
        }
      })();

      console.error(
        `Processed embeddings for batch ${
          i / config.BATCH_SIZE + 1
        }/${Math.ceil(chunks.length / config.BATCH_SIZE)}`
      );
    } catch (error) {
      console.error("Error generating embeddings:", error);
      throw error;
    }
  }

  // Update branch status to complete
  db.run("UPDATE branch SET status = 'complete' WHERE id = :id", {
    id: branch.id,
  });
};

/**
 * Get the default branch of a repository
 * @param owner GitHub repository owner
 * @param repo GitHub repository name
 * @returns Default branch name (usually main or master)
 */
export const getDefaultBranch = async (
  owner: string,
  repo: string
): Promise<string> => {
  try {
    // Check if we have this repo locally
    // Note: Repository is stored with just the repo name, not in owner/repo structure
    const repoDir = path.join(config.REPO_CACHE_DIR, repo);

    if (fs.existsSync(repoDir)) {
      console.error(`Found local repo at ${repoDir}, determining default branch`);
      // If we have the repo locally, use git to determine the default branch
      const git = simpleGit(repoDir);

      // Fetch the latest info from the remote
      await git.fetch();

      // Get the symbolic-ref of HEAD
      const headRef = await git.raw([
        "symbolic-ref",
        "refs/remotes/origin/HEAD",
      ]);

      // Extract the branch name
      const branchMatch = headRef.trim().match(/refs\/remotes\/origin\/(.+)$/);
      if (branchMatch && branchMatch[1]) {
        console.error(`Found default branch: ${branchMatch[1]}`);
        return branchMatch[1];
      }
    } else {
      console.error(`Repository not found at ${repoDir}`);
    }

    // Fallback to main as the default branch
    console.error(`Fallback to 'main' as default branch`);
    return "main";
  } catch (error) {
    console.error("Error getting default branch:", error);
    // Default to 'main' if there's an error
    return "main";
  }
};

/**
 * Query a repository using embeddings to find relevant code
 * @param query Search query text
 * @param owner Repository owner
 * @param repo Repository name
 * @param branch Branch name
 * @param topK Number of results to return
 * @returns Array of matching code chunks with metadata
 */
export const queryRepository = async (
  query: string,
  owner: string,
  repo: string,
  branch: string,
  topK: number = 5
): Promise<any[]> => {
  // Generate embedding for the query
  const queryEmbeddingList = await generateOllamaEmbeddings([query]);
  const queryEmbedding = queryEmbeddingList[0];

  // Get repository metadata from the database
  const repoResult = db.get("SELECT id FROM repository WHERE name = :repo", {
    repo,
  }) as { id: number } | undefined;

  if (!repoResult) {
    throw new Error(`Repository ${owner}/${repo} not found in database`);
  }
  const repoId = repoResult.id;

  // Get branch metadata
  const branchResult = db.get(
    "SELECT id FROM branch WHERE name = :branch AND repository_id = :repoId",
    { branch, repoId }
  ) as { id: number } | undefined;

  if (!branchResult) {
    throw new Error(
      `Branch ${branch} not found in repository ${owner}/${repo}`
    );
  }

  // Query for similar chunks using vector similarity
  const chunkResults = db.all(
    `SELECT 
      c.id, 
      c.content, 
      c.chunk_number,
      f.path,
      vector_similarity(c.embedding, :queryEmbedding) as similarity
    FROM 
      chunk c
    JOIN 
      file f ON c.file_id = f.id
    JOIN 
      branch b ON b.repository_id = f.repository_id
    WHERE 
      b.id = :branchId AND
      f.repository_id = :repoId AND
      c.embedding IS NOT NULL
    ORDER BY 
      similarity DESC 
    LIMIT :topK`,
    {
      branchId: branchResult.id,
      repoId,
      queryEmbedding,
      topK,
    }
  );

  return chunkResults;
};
