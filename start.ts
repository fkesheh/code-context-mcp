#!/usr/bin/env node

import { spawn } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATA_DIR = process.env.DATA_DIR || join(process.env.HOME!, '.config', 'Claude', 'data');
const REPO_CONFIG_DIR = process.env.REPO_CONFIG_DIR || join(process.env.HOME!, '.config', 'Claude', 'repos');
const NODE_ENV = process.env.NODE_ENV || 'development';

[DATA_DIR, REPO_CONFIG_DIR].forEach(dir => {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o755 });
  }
});

// Log to a file instead of stderr to avoid JSON parsing conflicts
// Uncomment these lines if you need debug output, but redirect to a log file
// process.stderr.write(`Starting Code Context MCP Server\n`);
// process.stderr.write(`Data Directory: ${DATA_DIR}\n`);
// process.stderr.write(`Repo Config: ${REPO_CONFIG_DIR}\n`);
// process.stderr.write(`Node Environment: ${NODE_ENV}\n\n`);

const checkOllama = () => {
  try {
    const result = spawn('pgrep', ['ollama'], { stdio: 'pipe' });
    result.on('exit', (code) => {
      if (code !== 0) {
        // process.stderr.write('Starting Ollama...\n');
        spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => startMcpServer(), 3000);
      } else {
        startMcpServer();
      }
    });
  } catch {
    startMcpServer();
  }
};

const startMcpServer = () => {
  const serverPath = join(__dirname, 'index.js');
  
  if (!existsSync(serverPath)) {
    process.stderr.write(`Error: MCP server not found at ${serverPath}\n`);
    process.stderr.write('Run: npm run build\n');
    process.exit(1);
  }

  process.env.DATA_DIR = DATA_DIR;
  process.env.REPO_CONFIG_DIR = REPO_CONFIG_DIR;
  process.env.NODE_ENV = NODE_ENV;

  const server = spawn('node', [serverPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    cwd: __dirname
  });

  server.on('exit', (code) => process.exit(code || 0));
};

checkOllama();
