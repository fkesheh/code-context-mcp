import { z } from "zod";
import { simpleGit } from "simple-git";
import path from "path";
import fs from "fs";
import dbInterface from "../utils/db.js";
import { ProgressNotifier } from "../utils/types.js";
import config from "../config.js";

// Define input schema for ingestBranch
export const IngestBranchSchema = z.object({
  repoUrl: z.string().describe("GitHub repository URL"),
  branch: z
    .string()
    .optional()
    .describe("Branch name to query (defaults to repository's default branch)"),
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


const cloneRepository = async (
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

// Modified cloneRepository function wrapper that reports progress
async function cloneRepositoryWithProgress(
  repoUrl: string, 
  reposDir: string, 
  progressNotifier?: ProgressNotifier
): Promise<string> {
  // Send initial progress notification (start of cloning - 0% of the 33%)
  if (progressNotifier) {
    await progressNotifier.sendProgress(0, 1);
  }
  
  // Set up a timer to periodically send progress updates
  let progressPercentage = 0;
  let isCloning = true;
  const progressInterval = 1500; // 1.5 seconds between updates
  const maxProgress = 0.30; // Progress up to 30% (reserving 3% for completion)
  const progressStep = 0.02; // Increments of 2%
  
  // Create an interval that will send progress updates periodically
  let timer: NodeJS.Timeout | null = null;
  
  if (progressNotifier) {
    timer = setInterval(async () => {
      if (isCloning && progressPercentage < maxProgress) {
        progressPercentage += progressStep;
        await progressNotifier!.sendProgress(progressPercentage, 1);
      }
    }, progressInterval);
  }
  
  try {
    // Start cloning operation
    const repoLocalPath = await cloneRepository(repoUrl, reposDir);
    
    // Clone completed
    isCloning = false;
    
    // Send completion of cloning phase (33% of total progress)
    if (progressNotifier) {
      await progressNotifier.sendProgress(0.33, 1);
    }
    
    return repoLocalPath;
  } finally {
    // Clean up the timer when done
    if (timer) {
      clearInterval(timer);
    }
  }
}

export async function ingestBranch(
  input: z.infer<typeof IngestBranchSchema>,
  progressNotifier?: ProgressNotifier
) {
  try {
    console.error(
      `[ingestBranch] Starting with parameters: ${JSON.stringify(input)}`
    );

    // Check if input is defined
    if (!input) {
      console.error(`[ingestBranch] Error: Input parameters are undefined`);
      return {
        error: {
          message: "Input parameters are required for ingestBranch tool",
        },
      };
    }

    const startTime = Date.now();
    const { repoUrl, branch } = input;

    // Validate required parameters
    if (!repoUrl) {
      console.error(`[ingestBranch] Error: Missing required parameter repoUrl`);
      return {
        error: {
          message: "Required parameter (repoUrl) is missing",
        },
      };
    }

    const reposDir = config.REPO_CACHE_DIR;

    // If branch is not specified, we'll get the default branch after cloning
    let actualBranch = branch || "";
    
    console.error(
      `[ingestBranch] Cloning repository: ${repoUrl}, branch: ${actualBranch || 'default'}`
    );
    
    // Use the modified clone function that reports progress (33% of total)
    const repoLocalPath = await cloneRepositoryWithProgress(repoUrl, reposDir, progressNotifier);
    
    console.error(
      `[ingestBranch] Repository cloned to: ${repoLocalPath} (${
        Date.now() - startTime
      }ms)`
    );

    // Initialize git
    const git = simpleGit(repoLocalPath);

    // If branch is not specified, get the default branch using git
    if (!actualBranch) {
      console.error(`[ingestBranch] Branch not specified, getting default branch`);
      try {
        // Get the default branch name
        const defaultBranch = await git.revparse(['--abbrev-ref', 'HEAD']);
        actualBranch = defaultBranch;
        console.error(`[ingestBranch] Using default branch: ${actualBranch}`);
      } catch (error) {
        console.error(`[ingestBranch] Error getting default branch:`, error);
        // Fallback to 'main' if we can't determine the default branch
        actualBranch = "main";
        console.error(`[ingestBranch] Falling back to branch: ${actualBranch}`);
      }
    }

    // Checkout the branch
    console.error(`[ingestBranch] Checking out branch: ${actualBranch}`);
    await git.checkout(actualBranch);
    const latestCommit = await git.revparse([actualBranch]);
    console.error(`[ingestBranch] Latest commit SHA: ${latestCommit}`);

    // Extract repo name from URL
    const repoName = path.basename(repoUrl, ".git");

    // Check if repo exists in database
    console.error(
      `[ingestBranch] Checking if repo exists in database: ${repoName}`
    );
    const repoExists = dbInterface.get(
      "SELECT id FROM repository WHERE name = ?",
      repoName
    );

    let repoId;
    if (repoExists) {
      repoId = repoExists.id;
      console.error(
        `[ingestBranch] Repository found in database with ID: ${repoId}`
      );
    } else {
      // Register repository
      console.error(`[ingestBranch] Registering new repository: ${repoName}`);
      const result = dbInterface.run(
        "INSERT INTO repository (name, path) VALUES (?, ?)",
        [repoName, repoLocalPath]
      );
      repoId = result.lastInsertRowid;
      console.error(`[ingestBranch] Repository registered with ID: ${repoId}`);
    }

    // Check if branch exists and has the same commit SHA
    console.error(`[ingestBranch] Checking if branch exists in database`);
    const branchExists = dbInterface.get(
      "SELECT id, last_commit_sha, status FROM branch WHERE name = ? AND repository_id = ?",
      [actualBranch, repoId]
    );

    let branchId;
    let needsUpdate = false;

    if (branchExists) {
      branchId = branchExists.id;
      console.error(
        `[ingestBranch] Branch found in database with ID: ${branchId}`
      );
      
      // Step 1: Check if SHA changed
      if (branchExists.last_commit_sha !== latestCommit) {
        console.error(`[ingestBranch] Commit SHA changed, updating branch: ${branchId}`);
        // Update branch commit SHA and set status to 'pending'
        dbInterface.run(
          "UPDATE branch SET last_commit_sha = ?, status = 'pending' WHERE id = ?",
          [latestCommit, branchId]
        );
        needsUpdate = true;
      }
      
      // Step 2: Check if status is not embeddings_generated
      if (branchExists.status !== 'embeddings_generated') {
        console.error(`[ingestBranch] Branch status is "${branchExists.status}" not "embeddings_generated", needs processing`);
        needsUpdate = true;
      }

      if (!needsUpdate) {
        console.error(`[ingestBranch] No changes needed, skipping update`);
      }
    } else {
      // Register the branch
      console.error(`[ingestBranch] Registering new branch: ${actualBranch}`);
      const result = dbInterface.run(
        "INSERT INTO branch (name, repository_id, last_commit_sha, status) VALUES (?, ?, ?, 'pending')",
        [actualBranch, repoId, latestCommit]
      );
      branchId = result.lastInsertRowid;
      needsUpdate = true;
      console.error(`[ingestBranch] Branch registered with ID: ${branchId}`);
    }

    // We don't process files directly here, just return the state
    // The actual file processing will happen in processFiles.ts
    return {
      repoLocalPath,
      repoId,
      branchId,
      needsUpdate,
      repoName,
      actualBranch,
      latestCommit
    };
  } catch (error) {
    console.error(`[ingestBranch] Error executing tool:`, error);
    return {
      error: {
        message: `Error executing ingestBranch tool: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}
