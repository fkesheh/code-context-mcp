import path from "path";
import fs from "fs";
import crypto from "crypto";
import { splitDocument, extensionToSplitter } from "./codeSplitter.js";
import { generateHuggingFaceEmbeddings } from "./hfEmbeddings.js";
import dbInterface from "./db.js";
import { simpleGit } from 'simple-git';
import Database from "better-sqlite3";

// Constants
const REPO_CACHE_DIR = process.env.REPO_CACHE_DIR || "./repos";
const BATCH_SIZE = 100; // Batch size for embedding generation

// Ensure the repository cache directory exists
if (!fs.existsSync(REPO_CACHE_DIR)) {
  fs.mkdirSync(REPO_CACHE_DIR, { recursive: true });
}

// Initialize database
let db: any;

/**
 * Initialize the database
 */
export const setupDatabase = async (): Promise<void> => {
  db = dbInterface;
};

/**
 * Get a repository by owner and name, clone if it doesn't exist
 */
export const getRepository = async (owner: string, repo: string): Promise<string> => {
  const repoDir = path.join(REPO_CACHE_DIR, owner, repo);
  
  // Check if repository already exists locally
  if (fs.existsSync(repoDir)) {
    return repoDir;
  }
  
  // Create directory if it doesn't exist
  fs.mkdirSync(path.join(REPO_CACHE_DIR, owner), { recursive: true });
  
  // Clone the repository
  const repoUrl = `https://github.com/${owner}/${repo}.git`;
  const git = simpleGit();
  
  console.error(`Cloning repository ${repoUrl} to ${repoDir}...`);
  await git.clone(repoUrl, repoDir);
  
  return repoDir;
};

/**
 * Onboard a repository branch - register it in the database
 */
export const onboardBranch = async (branch: string, owner: string, repo: string): Promise<void> => {
  // Get the repository directory
  const repoDir = await getRepository(owner, repo);
  const git = simpleGit(repoDir);
  
  // Fetch the latest changes
  await git.fetch();
  
  // Get the latest commit for the branch
  const branchSummary = await git.branch(["-v"]);
  const branchInfo = branchSummary.branches[branch];
  
  if (!branchInfo) {
    throw new Error(`Branch ${branch} not found in repository ${owner}/${repo}`);
  }
  
  // Get the commit SHA
  const lastCommitSha = branchInfo.commit;
  
  // Insert or update repository record
  db.run(`
    INSERT INTO repo (owner, name, last_updated) 
    VALUES (?, ?, CURRENT_TIMESTAMP) 
    ON CONFLICT (owner, name) DO UPDATE 
    SET last_updated = CURRENT_TIMESTAMP
  `, [owner, repo]);
  
  // Get the repository ID
  const repoResult = db.get("SELECT id FROM repo WHERE owner = ? AND name = ?", [owner, repo]) as { id: number };
  const repoId = repoResult.id;
  
  // Insert or update branch record
  db.run(`
    INSERT INTO branch (name, last_commit_sha, repo_id, status)
    VALUES (?, ?, ?, 'pending')
    ON CONFLICT (name, repo_id) DO UPDATE
    SET last_commit_sha = ?,
        status = CASE
                   WHEN branch.last_commit_sha <> ? THEN 'pending'
                   ELSE branch.status
                 END
  `, [branch, lastCommitSha, repoId, lastCommitSha, lastCommitSha]);
  
  return;
};

/**
 * List all files in a directory recursively
 */
const listFilesRecursively = (dir: string, ignorePatterns: RegExp[] = [/node_modules/, /\.git/]): string[] => {
  let results: string[] = [];
  
  const list = fs.readdirSync(dir);
  
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const relativePath = path.relative(dir, fullPath);
    
    // Check against ignore patterns
    if (ignorePatterns.some(pattern => pattern.test(relativePath))) {
      continue;
    }
    
    const stat = fs.statSync(fullPath);
    
    if (stat.isDirectory()) {
      // Recursively list files in subdirectory
      const subResults = listFilesRecursively(fullPath, ignorePatterns);
      results = results.concat(subResults.map(subPath => path.join(relativePath, subPath)));
    } else {
      results.push(relativePath);
    }
  }
  
  return results;
};

/**
 * Generate a file hash for content-based comparison
 */
const getFileHash = (filePath: string): string => {
  const content = fs.readFileSync(filePath, 'utf-8');
  let hash = 0;
  
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  
  return hash.toString(16);
};

/**
 * Ingest all files from a branch
 */
export const ingestBranchFiles = async (branch: string, owner: string, repo: string): Promise<void> => {
  // Get repository directory
  const repoDir = await getRepository(owner, repo);
  
  // Initialize Git
  const git = simpleGit(repoDir);
  await git.checkout(branch);
  
  // Get the repo ID from database
  const repoResult = db.get("SELECT id FROM repo WHERE owner = ? AND name = ?", [owner, repo]) as { id: number } | undefined;
  
  if (!repoResult) {
    throw new Error(`Repository ${owner}/${repo} not found in database`);
  }
  const repoId = repoResult.id;
  
  // Get the branch ID from database
  const branchResult = db.get("SELECT id FROM branch WHERE name = ? AND repo_id = ?", [branch, repoId]) as { id: number } | undefined;
  
  if (!branchResult) {
    throw new Error(`Branch ${branch} not found in database`);
  }
  const branchId = branchResult.id;
  
  // Begin transaction
  db.transaction((dbOps: any) => {
    // List all files in the repository
    const files = listFilesRecursively(repoDir);
    
    // Track processed file IDs for cleanup
    const processedFileIds: number[] = [];
    
    // Process each file
    for (const filePath of files) {
      const fullPath = path.join(repoDir, filePath);
      const fileName = path.basename(filePath);
      const fileHash = getFileHash(fullPath);
      
      // Insert or update file info
      const fileResult = dbOps.get(`
        WITH ins AS (
          INSERT INTO file (repo_id, path, sha, name, status)
          VALUES (?, ?, ?, ?, 'pending')
          ON CONFLICT(repo_id, path) DO UPDATE SET
            sha = excluded.sha,
            status = 'pending'
          RETURNING id
        )
        SELECT id FROM ins
        UNION ALL
        SELECT id FROM file WHERE repo_id = ? AND path = ?
        LIMIT 1
      `, [repoId, filePath, fileHash, fileName, repoId, filePath]);
      
      const fileId = fileResult.id;
      processedFileIds.push(fileId);
      
      // Associate file with branch
      dbOps.run(`
        INSERT INTO branch_file_association (branch_id, file_id)
        VALUES (?, ?)
        ON CONFLICT DO NOTHING
      `, [branchId, fileId]);
    }
    
    // Remove files that are no longer in the repository
    dbOps.run(`
      DELETE FROM branch_file_association
      WHERE branch_id = ?
      AND file_id NOT IN (${processedFileIds.join(',') || '-1'})
    `, [branchId]);
    
    // Update branch status
    dbOps.run(`
      UPDATE branch SET status = 'files_processed'
      WHERE id = ?
    `, [branchId]);
  });
  
  console.error(`Ingested ${branch} branch of ${owner}/${repo}`);
};

/**
 * Fetch and process file contents for all pending files
 */
export const fetchBranchFiles = async (branch: string, owner: string, repo: string): Promise<void> => {
  // Get repository directory
  const repoDir = await getRepository(owner, repo);
  
  // Get all pending files for the branch
  const pendingFiles = db.all(`
    SELECT DISTINCT f.id, f.path, f.sha
    FROM file f
    JOIN branch_file_association bfa ON f.id = bfa.file_id
    JOIN branch b ON bfa.branch_id = b.id
    JOIN repo r ON b.repo_id = r.id
    WHERE b.name = ?
    AND r.owner = ?
    AND r.name = ?
    AND f.status = 'pending'
    ORDER BY f.path ASC
  `, [branch, owner, repo]) as { id: number, path: string, sha: string }[];
  
  // Begin transaction
  for (const file of pendingFiles) {
    const fullPath = path.join(repoDir, file.path);
    const extension = path.extname(file.path).slice(1).toLowerCase();
    const splitType = extensionToSplitter(extension);
    
    if (splitType === "ignore") {
      // Update file status to 'done' for ignored files
      db.run("UPDATE file SET status = 'done' WHERE id = ?", [file.id]);
      continue;
    }
    
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      
      // Split the document into chunks
      const docChunks = await splitDocument(file.path, content);
      
      // Store chunks in the database
      db.transaction(() => {
        for (let i = 0; i < docChunks.length; i++) {
          db.run(`
            INSERT INTO file_chunk (file_id, content, chunk_number)
            VALUES (?, ?, ?)
            ON CONFLICT DO NOTHING
          `, [file.id, docChunks[i].pageContent, i + 1]);
        }
        
        // Update file status to 'fetched'
        db.run("UPDATE file SET status = 'fetched' WHERE id = ?", [file.id]);
      });
    } catch (error) {
      console.error(`Error processing file ${file.path}:`, error);
    }
  }
  
  console.error(`Fetched files from ${branch} branch of ${owner}/${repo}`);
};

/**
 * Generate embeddings for file chunks
 */
export const embedBranchFiles = async (branch: string, owner: string, repo: string): Promise<void> => {
  let totalEmbeddedChunks = 0;
  let allChunksEmbedded = false;
  
  while (!allChunksEmbedded) {
    // Get chunks that haven't been embedded yet    
    const pendingChunks = db.all(`
      SELECT fc.chunk_number, fc.content, f.id as file_id
      FROM file_chunk fc
      JOIN file f ON fc.file_id = f.id
      JOIN repo r ON f.repo_id = r.id
      JOIN branch_file_association bfa ON f.id = bfa.file_id
      JOIN branch b ON bfa.branch_id = b.id
      WHERE fc.embedding IS NULL 
      AND f.status = 'fetched'
      AND r.owner = ?
      AND r.name = ?
      AND b.name = ?
      LIMIT ?
    `, [owner, repo, branch, BATCH_SIZE]) as 
      { chunk_number: number, content: string, file_id: number }[];
    
    if (pendingChunks.length === 0) {
      allChunksEmbedded = true;
      break;
    }
    
    // Prepare batch request
    const batchedContents = pendingChunks.map(chunk => chunk.content);
    
    // Generate embeddings using HuggingFace
    const embeddings = await generateHuggingFaceEmbeddings(batchedContents);
    
    // Begin transaction
    db.transaction(() => {
      // Store the embeddings in the database
      for (let i = 0; i < pendingChunks.length; i++) {
        const chunk = pendingChunks[i];
        const embedding = embeddings[i];
        
        db.run(`
          UPDATE file_chunk 
          SET embedding = ?, model_version = ?
          WHERE file_id = ? AND chunk_number = ?
        `, [JSON.stringify(embedding), 'huggingface', chunk.file_id, chunk.chunk_number]);
      }
      
      // Update file status to 'ingested' only if all chunks are embedded
      const fileIds = [...new Set(pendingChunks.map(chunk => chunk.file_id))];
      for (const fileId of fileIds) {
        db.run(`
          UPDATE file 
          SET status = 'ingested' 
          WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 
            FROM file_chunk 
            WHERE file_chunk.file_id = file.id 
            AND file_chunk.embedding IS NULL
          )
        `, [fileId]);
      }
      
      // Get the branch ID
      const branchResult = db.get(`
        SELECT b.id
        FROM branch b
        JOIN repo r ON b.repo_id = r.id
        WHERE b.name = ?
        AND r.owner = ?
        AND r.name = ?
      `, [branch, owner, repo]) as { id: number };
      
      // Update branch status to 'embeddings_generated' if all files are ingested
      db.run(`
        UPDATE branch
        SET status = 'embeddings_generated'
        WHERE id = ?
        AND NOT EXISTS (
          SELECT 1
          FROM branch_file_association bfa
          JOIN file f ON bfa.file_id = f.id
          WHERE bfa.branch_id = ?
          AND f.status != 'ingested'
        )
      `, [branchResult.id, branchResult.id]);
    });
    
    totalEmbeddedChunks += pendingChunks.length;
    console.error(`Embedded chunks: ${totalEmbeddedChunks}`);
  }
  
  return;
};

/**
 * Get the default branch of a repository
 */
export const getDefaultBranch = async (owner: string, repo: string): Promise<string> => {
  // Get repository directory
  const repoDir = await getRepository(owner, repo);
  
  // Initialize Git
  const git = simpleGit(repoDir);
  
  // Get remote information
  const remoteInfo = await git.remote(['show', 'origin']);
  
  // Extract the default branch from the remote info
  if (remoteInfo && typeof remoteInfo === 'string') {
    const match = remoteInfo.match(/HEAD branch: (.+)/);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // Fallback to 'main' if we can't determine the default branch
  return 'main';
};

/**
 * Query a repository using embeddings to find relevant code
 */
export const queryRepository = async (query: string, owner: string, repo: string, branch: string, topK: number = 5): Promise<any[]> => {
  // Generate embedding for the query
  const queryEmbedding = await generateHuggingFaceEmbeddings([query]);
  
  // Get the branch ID
  const branchResult = db.get(`
    SELECT b.id
    FROM branch b
    JOIN repo r ON b.repo_id = r.id
    WHERE b.name = ?
    AND r.owner = ?
    AND r.name = ?
  `, [branch, owner, repo]) as { id: number } | undefined;
  
  if (!branchResult) {
    throw new Error(`Branch ${branch} not found for repository ${owner}/${repo}`);
  }
  
  const branchId = branchResult.id;
  
  // Query for similar code chunks using vector similarity
  const similarChunks = db.all(`
    SELECT fc.content, f.path, fc.chunk_number, 
    (SELECT similarity(fc.embedding, ?)) as similarity
    FROM file_chunk fc
    JOIN file f ON fc.file_id = f.id
    JOIN branch_file_association bfa ON f.id = bfa.file_id
    WHERE bfa.branch_id = ?
    ORDER BY similarity DESC
    LIMIT ?
  `, [JSON.stringify(queryEmbedding), branchId, topK]);
  
  return similarChunks;
};
