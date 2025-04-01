import { z } from "zod";
import dbInterface from "../utils/db.js";
import { ProgressNotifier } from "../utils/types.js";
import { simpleGit } from "simple-git";
import path from "path";
import { extensionToSplitter, splitDocument } from "../utils/codeSplitter.js";
import fs from "fs";

interface RepositoryFile {
  path: string;
  name: string;
  sha: string;
}

interface RepositoryFilesResult {
  files: RepositoryFile[];
  commitSha: string;
}

interface PendingFile {
  id: number;
  path: string;
  sha: string;
}


// Define input schema for processFiles
export const ProcessFilesSchema = z.object({
  repoLocalPath: z.string().describe("Local path to the cloned repository"),
  repoId: z.number().describe("Repository ID in the database"),
  branchId: z.number().describe("Branch ID in the database"),
  actualBranch: z.string().describe("Actual branch name"),
  needsUpdate: z.boolean().describe("Whether the branch needs updating"),
  _meta: z
    .object({
      progressToken: z.union([z.string(), z.number()]).optional(),
    })
    .optional(),
});


/**
 * Get the files in a repository branch
 * @param repoPath Path to the repository
 * @param branchName Name of the branch
 * @returns List of files with their metadata
 */
export const getRepositoryFiles = async (
  repoPath: string,
  branchName: string,
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
  const repo = dbInterface.get("SELECT id FROM repository WHERE path = ?", repoPath) as { id: number };
  const branch = dbInterface.get(
    "SELECT id FROM branch WHERE name = ? AND repository_id = ?",
    [branchName, repo.id]
  ) as { id: number };

  // Get all pending files for the branch
  const pendingFiles = dbInterface.all(
    `SELECT f.id, f.path, f.sha
     FROM file f
     JOIN branch_file_association bfa ON f.id = bfa.file_id
     WHERE f.status = 'pending' AND bfa.branch_id = ?`,
    branch.id
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

        // Store chunks in the database using dbInterface.transaction
        dbInterface.transaction((db) => {
          for (let i = 0; i < chunks.length; i++) {
            db.prepare(
              `INSERT INTO file_chunk (file_id, content, chunk_number)
               VALUES (?, ?, ?)
               ON CONFLICT(file_id, chunk_number) DO NOTHING`
            ).run(file.id, chunks[i].pageContent, i + 1);
          }

          // Update file status to 'fetched'
          db.prepare("UPDATE file SET status = ? WHERE id = ?").run(
            "fetched",
            file.id
          );
        });
      } catch (error) {
        console.error(`Error processing file ${file.path}:`, error);
      }
    } else {
      // Update file status to 'done' for ignored files
      dbInterface.run("UPDATE file SET status = ? WHERE id = ?", ["done", file.id]);
    }
  }
};

export async function processFiles(
  input: z.infer<typeof ProcessFilesSchema>,
  progressNotifier?: ProgressNotifier
) {
  try {
    console.error(
      `[processFiles] Starting with parameters: ${JSON.stringify(input)}`
    );

    // Check if input is defined
    if (!input) {
      console.error(`[processFiles] Error: Input parameters are undefined`);
      return {
        error: {
          message: "Input parameters are required for processFiles tool",
        },
      };
    }

    const startTime = Date.now();
    const { repoLocalPath, repoId, branchId, actualBranch, needsUpdate } = input;

    // Skip if no update is needed
    if (!needsUpdate) {
      console.error(`[processFiles] No update needed, skipping`);
      return { 
        needsUpdate: false,
        filesToProcess: []
      };
    }

    // Process the repository files
    console.error(
      `[processFiles] Processing repository files (${Date.now() - startTime}ms)`
    );
    // Get all files in the repository
    const { files } = await getRepositoryFiles(repoLocalPath, actualBranch);
    console.error(`[processFiles] Found ${files.length} files in repository`);

    // Define transaction function
    console.error(`[processFiles] Starting file database transaction`);
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
        `[processFiles] Found ${existingFiles.length} existing files in database`
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
          // New file - but first check if it already exists in the database for another branch
          const existingFileInDB = db.prepare(
            "SELECT id FROM file WHERE repository_id = ? AND path = ? AND sha = ?"
          ).get(repoId, file.path, file.sha);

          let fileId;
          if (existingFileInDB) {
            // File exists but not associated with this branch
            console.error(`[processFiles] File exists in DB but not associated with branch: ${file.path}`);
            fileId = existingFileInDB.id;
            
            // Check if the file is already associated with this branch
            const associationExists = db.prepare(
              "SELECT 1 FROM branch_file_association WHERE branch_id = ? AND file_id = ?"
            ).get(branchId, fileId);

            if (!associationExists) {
              // Associate existing file with current branch
              db.prepare(
                "INSERT INTO branch_file_association (branch_id, file_id) VALUES (?, ?)"
              ).run(branchId, fileId);
            }
          } else {
            // Truly new file
            newFiles++;
            const result = db
              .prepare(
                "INSERT INTO file (repository_id, path, sha, name, status) VALUES (?, ?, ?, ?, 'pending')"
              )
              .run(repoId, file.path, file.sha, file.name);

            fileId = result.lastInsertRowid;

            // Associate with branch
            db.prepare(
              "INSERT INTO branch_file_association (branch_id, file_id) VALUES (?, ?)"
            ).run(branchId, fileId);
          }

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
        `[processFiles] Files summary: ${newFiles} new, ${updatedFiles} updated, ${unchangedFiles} unchanged, ${removedFiles} removed`
      );
      return filesToProcess;
    };

    // Execute the transaction
    console.error(`[processFiles] Executing file processing transaction`);
    const filesToProcess = dbInterface.transaction((db) => processFiles(db));
    console.error(
      `[processFiles] Transaction completed, processing ${
        filesToProcess.length
      } files (${Date.now() - startTime}ms)`
    );

    // Limit the number of files processed to avoid timeouts
    // This might need adjustment based on actual performance
    const MAX_FILES_TO_PROCESS = 1000000;
    const limitedFiles = filesToProcess.slice(0, MAX_FILES_TO_PROCESS);

    if (limitedFiles.length < filesToProcess.length) {
      console.error(
        `[processFiles] WARNING: Processing only ${limitedFiles.length} of ${filesToProcess.length} files to avoid timeout`
      );
    }

    // Update progress for file processing phase (33% to 66%)
    if (progressNotifier) {
      await progressNotifier.sendProgress(0.33, 1);
    }

    // Process file contents to generate chunks - this was the missing step
    console.error(`[processFiles] Processing file contents for branch: ${actualBranch}`);
    try {
      await processFileContents(actualBranch, repoLocalPath);
      console.error(`[processFiles] File contents processed successfully`);
      
      // Update branch status to files_processed
      dbInterface.run(
        "UPDATE branch SET status = 'files_processed' WHERE id = ?",
        branchId
      );
      
      // Update progress after file content processing
      if (progressNotifier) {
        await progressNotifier.sendProgress(0.66, 1);
      }
    } catch (error) {
      console.error(`[processFiles] Error processing file contents:`, error);
    }

    return {
      needsUpdate: true,
      filesToProcess: limitedFiles,
      repoLocalPath
    };
  } catch (error) {
    console.error(`[processFiles] Error executing tool:`, error);
    return {
      error: {
        message: `Error executing processFiles tool: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
}
