# Code Context MCP Server

[![smithery badge](https://smithery.ai/badge/@fkesheh/code-context-mcp)](https://smithery.ai/server/@fkesheh/code-context-mcp)

A Model Context Protocol (MCP) server for providing code context from local git repositories. This server allows you to:

1. Clone git repositories locally
2. Process branches and files
3. Generate embeddings for code chunks
4. Perform semantic search over code

## Features

- Uses local git repositories instead of GitHub API
- Stores data in SQLite database
- Splits code into semantic chunks
- Generates embeddings for code chunks using Ollama
- Provides semantic search over code

## Prerequisites

- Node.js (v16+)
- Git
- Ollama with an embedding model

## Installation

### Installing via Smithery

To install Code Context Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@fkesheh/code-context-mcp):

```bash
npx -y @smithery/cli install @fkesheh/code-context-mcp --client claude
```

### Manual Installation
```bash
# Clone the repository
git clone <repository-url>
cd code-context-mcp

# Install dependencies
npm install

# Build the project
npm run build
```

## Configuration

Set the following environment variables:

- `DATA_DIR`: Directory for SQLite database (default: '~/.codeContextMcp/data')
- `REPO_CACHE_DIR`: Directory for cloned repositories (default: '~/.codeContextMcp/repos')

### Using Ollama

For faster and more powerful embeddings, you can use Ollama:

```bash
# Install Ollama from https://ollama.ai/

# Pull an embedding model (unclemusclez/jina-embeddings-v2-base-code is recommended)
ollama pull unclemusclez/jina-embeddings-v2-base-code

```

## Usage

### Using with Claude Desktop

Add the following configuration to your Claude Desktop configuration file (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "code-context-mcp": {
      "command": "/path/to/your/node",
      "args": ["/path/to/code-context-mcp/dist/index.js"]
    }
  }
}
```

## Tools

The server provides the following tool:

### queryRepo

Clones a repository, processes code, and performs semantic search:

```json
{
  "repoUrl": "https://github.com/username/repo.git",
  "branch": "main", // Optional - defaults to repository's default branch
  "query": "Your search query",
  "keywords": ["keyword1", "keyword2"], // Optional - filter results by keywords
  "filePatterns": ["**/*.ts", "src/*.js"], // Optional - filter files by glob patterns
  "excludePatterns": ["**/node_modules/**"], // Optional - exclude files by glob patterns
  "limit": 10 // Optional - number of results to return, default: 10
}
```

The `branch` parameter is optional. If not provided, the tool will automatically use the repository's default branch.

The `keywords` parameter is optional. If provided, the results will be filtered to only include chunks that contain at least one of the specified keywords (case-insensitive matching).

The `filePatterns` and `excludePatterns` parameters are optional. They allow you to filter which files are processed and searched using glob patterns (e.g., `**/*.ts` for all TypeScript files).

## Database Schema

The server uses SQLite with the following schema:

- `repository`: Stores information about repositories
- `branch`: Stores information about branches
- `file`: Stores information about files
- `branch_file_association`: Associates files with branches
- `file_chunk`: Stores code chunks and their embeddings

# Debugging

## MAC Mx Series - ARM Architecture Issues

When installing better-sqlite3 on Mac M-series chips (ARM architecture), if you encounter errors like "mach-o file, but is an incompatible architecture (have 'x86_64', need 'arm64e' or 'arm64')", you need to ensure the binary matches your architecture. Here's how to resolve this issue:

```bash
# Check your Node.js architecture
node -p "process.arch"

# If it shows 'arm64', but you're still having issues, try:
npm rebuild better-sqlite3 --build-from-source

# Or for a clean install:
npm uninstall better-sqlite3
export npm_config_arch=arm64
export npm_config_target_arch=arm64
npm install better-sqlite3 --build-from-source
```

If you're using Rosetta, make sure your entire environment is consistent. Your error shows x86_64 binaries being built but your system needs arm64.
For persistent configuration, add to your .zshrc or .bashrc:

```
export npm_config_arch=arm64
export npm_config_target_arch=arm64
```

## Testing Ollama Embeddings

curl http://localhost:11434/api/embed -d '{"model":"unclemusclez/jina-embeddings-v2-base-code","input":"Llamas are members of the camelid family"}'
curl http://127.0.01:11434/api/embed -d '{"model":"unclemusclez/jina-embeddings-v2-base-code","input":"Llamas are members of the camelid family"}'
curl http://[::1]:11434/api/embed -d '{"model":"unclemusclez/jina-embeddings-v2-base-code","input":"Llamas are members of the camelid family"}'

## License

MIT
