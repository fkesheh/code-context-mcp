# Code Context MCP Server

A Model Context Protocol (MCP) server for providing code context from local git repositories. This server allows you to:

1. Clone git repositories locally
2. Process branches and files
3. Generate embeddings for code chunks
4. Perform semantic search over code

## Features

- Uses local git repositories instead of GitHub API
- Stores data in SQLite database
- Splits code into semantic chunks
- Generates embeddings for code chunks using HuggingFace transformers
- Provides semantic search over code

## Prerequisites

- Node.js (v16+)
- Git
- HuggingFace transformers (all-MiniLM-L6-v2 model)

## Installation

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

- `HF_MODEL_NAME`: HuggingFace model name (default: 'all-MiniLM-L6-v2')
- `EMBEDDING_DIMENSIONS`: Dimensions for embeddings (default: 384 for all-MiniLM-L6-v2)
- `DATA_DIR`: Directory for SQLite database (default: './data')
- `CACHE_DIR`: Directory for cache files (default: './cache')
- `REPOS_DIR`: Directory for cloned repositories (default: './repos')

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
  "limit": 5 // Optional - number of results to return, default: 5
}
```

The `branch` parameter is optional. If not provided, the tool will automatically use the repository's default branch.

The `keywords` parameter is optional. If provided, the results will be filtered to only include chunks that contain at least one of the specified keywords (case-insensitive matching).

## Database Schema

The server uses SQLite with the following schema:

- `repository`: Stores information about repositories
- `branch`: Stores information about branches
- `file`: Stores information about files
- `branch_file_association`: Associates files with branches
- `file_chunk`: Stores code chunks and their embeddings

## License

MIT
