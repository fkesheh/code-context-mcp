#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { QueryRepoSchema, queryRepo } from "./tools/queryRepo.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { ProgressNotifier } from "utils/types.js";

enum ToolName {
  QUERY_REPO = "query_repo",
}

class CodeContextServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: "code-context-mcp",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupToolHandlers();

    // Error handling - comment out to avoid JSON parsing conflicts
    // this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: ToolName.QUERY_REPO,
          description: "Queries a git repository using semantic and keyword search. Use keywords and file patterns if you want to target specific files or terms",
          inputSchema: zodToJsonSchema(QueryRepoSchema),
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: input } = request.params;
      const progressToken = request.params._meta?.progressToken;

      switch (name) {
        case ToolName.QUERY_REPO:
          try {
            // Create a progress notifier if we have a progress token
            let progressNotifier: ProgressNotifier | undefined;
            
            if (progressToken !== undefined) {
              progressNotifier = {
                sendProgress: async (progress: number, total: number) => {
                  await this.server.notification({
                    method: "notifications/progress",
                    params: {
                      progress: Math.floor(progress * 100),
                      total: total * 100,
                      progressToken,
                    },
                  });
                },
              };
            }
            
            // Get the raw result from queryRepo with progress notifications
            const result = await queryRepo(
              input as z.infer<typeof QueryRepoSchema>,
              progressNotifier
            );
            
            // Format the response in Claude's expected structure
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            };
          } catch (error) {
            // console.error("Error in query_repo:", error);
            return {
              content: [
                {
                  type: "text",
                  text: `Error executing query: ${error instanceof Error ? error.message : String(error)}`,
                },
              ],
            };
          }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // console.error("Code Context MCP server running on stdio");
  }
}

const server = new CodeContextServer();
server.run().catch((_error) => {
  // Silent error handling to avoid JSON parsing conflicts
  process.exit(1);
});
