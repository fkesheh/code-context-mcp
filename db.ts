import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

// Ensure the data directory exists
const DATA_DIR = process.env.DATA_DIR || "./data";
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "code_context.db");
const db = new Database(DB_PATH);

// Enable foreign keys
db.pragma("foreign_keys = ON");

// SQL schema for the database
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS repository (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(path)
);

CREATE TABLE IF NOT EXISTS branch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  repository_id INTEGER NOT NULL,
  last_commit_sha TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'files_processed', 'embeddings_generated')) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repository_id) REFERENCES repository(id) ON DELETE CASCADE,
  UNIQUE(name, repository_id)
);

CREATE TABLE IF NOT EXISTS file (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository_id INTEGER NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT CHECK(status IN ('pending', 'fetched', 'ingested', 'done')) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (repository_id) REFERENCES repository(id) ON DELETE CASCADE,
  UNIQUE(repository_id, path, sha)
);

CREATE TABLE IF NOT EXISTS branch_file_association (
  branch_id INTEGER NOT NULL,
  file_id INTEGER NOT NULL,
  PRIMARY KEY (branch_id, file_id),
  FOREIGN KEY (branch_id) REFERENCES branch(id) ON DELETE CASCADE,
  FOREIGN KEY (file_id) REFERENCES file(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS file_chunk (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  content TEXT NOT NULL,
  chunk_number INTEGER NOT NULL,
  embedding TEXT,
  model_version TEXT,
  token_count INTEGER,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (file_id) REFERENCES file(id) ON DELETE CASCADE,
  UNIQUE(file_id, chunk_number)
);
`;

// Initialize the database
export const initializeDatabase = () => {
  try {
    // Split the schema SQL into individual statements
    const statements = SCHEMA_SQL.split(";").filter(
      (stmt) => stmt.trim().length > 0
    );

    // Execute each statement
    for (const statement of statements) {
      db.exec(statement + ";");
    }
  } catch (error) {
    console.error("Error initializing database:", error);
    throw error;
  }
};

// Helper function to run queries with parameters
const run = (sql: string, params: any = {}) => {
  return db.prepare(sql).run(params);
};

// Helper function to get a single row
const get = (sql: string, params: any = {}) => {
  return db.prepare(sql).get(params);
};

// Helper function to get all rows
const all = (sql: string, params: any = {}) => {
  return db.prepare(sql).all(params);
};

// Define a type for the database operations that can be performed in a transaction
export interface DatabaseOperations {
  prepare: (sql: string) => {
    run: (params?: any) => any;
    get: (params?: any) => any;
    all: (params?: any) => any;
  };
}

// Create a transaction function that's compatible with the existing code
const transaction = (cb: (dbOps: any) => any): any => {
  const runTransaction = db.transaction(cb);
  return runTransaction(db);
};

// Define a public interface for our database module
export interface DatabaseInterface {
  run: (sql: string, params?: any) => any;
  get: (sql: string, params?: any) => any;
  all: (sql: string, params?: any) => any;
  transaction: (cb: (dbOps: any) => any) => any;
  close: () => void;
}

// Initialize the database
initializeDatabase();

// Export the database interface
const dbInterface: DatabaseInterface = {
  run,
  get,
  all,
  transaction,
  close: () => db.close(),
};

export default dbInterface;
