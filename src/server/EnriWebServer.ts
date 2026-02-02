/**
 * ENRIWEB MCP SERVER
 *
 * Implements a minimal MCP server (stdio transport) exposing:
 * - `web_search`
 * - `web_fetch`
 *
 * @module server/EnriWebServer
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

import type { WebSearchTool } from "../tools/WebSearchTool.js";
import type { WebFetchTool } from "../tools/WebFetchTool.js";

/**
 * Configuration for {@link EnriWebServer}.
 */
export interface EnriWebServerConfig {
  /**
   * Server name reported via MCP.
   */
  readonly name: string;

  /**
   * Server version reported via MCP.
   */
  readonly version: string;

  /**
   * Web search tool implementation.
   */
  readonly webSearchTool: WebSearchTool;

  /**
   * Web fetch tool implementation.
   */
  readonly webFetchTool: WebFetchTool;
}

/**
 * MCP server exposing EnriWeb tools.
 */
export class EnriWebServer {
  /**
   * Underlying MCP server implementation.
   */
  private readonly server: Server;

  /**
   * Web search tool implementation.
   */
  private readonly webSearchTool: WebSearchTool;

  /**
   * Web fetch tool implementation.
   */
  private readonly webFetchTool: WebFetchTool;

  /**
   * Creates a new {@link EnriWebServer}.
   *
   * @param config - Server configuration
   */
  public constructor(config: EnriWebServerConfig) {
    this.webSearchTool = config.webSearchTool;
    this.webFetchTool = config.webFetchTool;

    this.server = new Server(
      { name: config.name, version: config.version },
      {
        capabilities: {
          tools: {
            listChanged: false
          }
        }
      }
    );

    this.registerToolHandlers();
  }

  /**
   * Connects the server to a transport and starts listening.
   *
   * @param transport - MCP transport (stdio)
   */
  public async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Registers tool list and tool call handlers.
   */
  private registerToolHandlers(): void {
    const tools = [
      this.getWebSearchToolDefinition(),
      this.getWebFetchToolDefinition()
    ];

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments ?? {};

      try {
        if (toolName === "web_search") {
          const params = this.webSearchTool.parseParams(args);
          const result = await this.webSearchTool.execute(params);
          return {
            isError: false,
            content: [{ type: "text", text: this.webSearchTool.formatOutput(result) }],
            structuredContent: result
          } satisfies CallToolResult;
        }

        if (toolName === "web_fetch") {
          const params = this.webFetchTool.parseParams(args);
          const result = await this.webFetchTool.execute(params);
          return {
            isError: false,
            content: [{ type: "text", text: this.webFetchTool.formatOutput(result) }],
            structuredContent: result
          } satisfies CallToolResult;
        }

        return {
          isError: true,
          content: [{ type: "text", text: `Unknown tool: ${toolName}` }]
        } satisfies CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        } satisfies CallToolResult;
      }
    });
  }

  /**
   * Returns the JSON schema tool definition for `web_search`.
   *
   * @returns Tool definition
   */
  private getWebSearchToolDefinition(): Tool {
    return {
      name: "web_search",
      description:
        "Search the web via EnriProxy's multi-tier search service.\n" +
        "\n" +
        "When to use:\n" +
        "- When you need to find current information, news, or documentation.\n" +
        "- When searching for technical solutions, APIs, or code examples.\n" +
        "- When you need to verify facts or find up-to-date sources.\n" +
        "\n" +
        "Features:\n" +
        "- Automatic fallback across multiple search backends (details intentionally not exposed)\n" +
        "- Automatic registry verification: enriches results with latest stable + prerelease versions when registry URLs are detected (npm, PyPI, crates.io, NuGet, GitHub)\n" +
        "- Domain filtering (allowlist/blocklist)\n" +
        "- Recency filtering (day/week/month/year)\n" +
        "\n" +
        "Notes:\n" +
        "- Provide specific queries for best results.\n" +
        "- Use recency filter for time-sensitive information.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query. Be specific for better results."
          },
          max_results: {
            type: "integer",
            description:
              "Maximum results (>= 1). If omitted, EnriProxy uses its configured default. The upper limit is enforced server-side."
          },
          recency: {
            type: "string",
            enum: ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"],
            description: "Filter by recency (default: noLimit)."
          },
          allowed_domains: {
            type: "array",
            items: { type: "string" },
            description: "Only return results from these domains."
          },
          blocked_domains: {
            type: "array",
            items: { type: "string" },
            description: "Exclude results from these domains."
          },
          search_prompt: {
            type: "string",
            description: "Optional context to refine search intent."
          }
        },
        required: ["query"]
      }
    };
  }

  /**
   * Returns the JSON schema tool definition for `web_fetch`.
   *
   * @returns Tool definition
   */
  private getWebFetchToolDefinition(): Tool {
    const defaultMaxChars = this.webFetchTool.getDefaultMaxChars();
    return {
      name: "web_fetch",
      description:
        "Fetch and read content from a URL via EnriProxy's multi-tier fetch service.\n" +
        "\n" +
        "When to use:\n" +
        "- When you need to read the full content of a webpage.\n" +
        "- When you need to access documentation, articles, or code files.\n" +
        "- When simpler fetch methods fail due to anti-bot protection.\n" +
        "\n" +
        "Features:\n" +
        "- Package registry API detection (npm, PyPI)\n" +
        "- Raw file fetch (GitHub raw, HuggingFace)\n" +
        "- Robust fetching for static, dynamic, and bot-protected sites (best-effort)\n" +
        "- Automatic fallback across multiple retrieval strategies (details intentionally not exposed)\n" +
        "\n" +
        "Notes:\n" +
        "- Provide the full URL including protocol (https://).\n" +
        `- Content is limited by the \`max_chars\` parameter (default: ${defaultMaxChars}).\n` +
        "- If the result is truncated and includes a `cursor`, call `web_fetch` again with `cursor` + `offset` + `limit` to read more without re-fetching.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL to fetch (http:// or https://)."
          },
          cursor: {
            type: "string",
            description:
              "Opaque cursor returned by a previous `web_fetch` call for pagination."
          },
          prompt: {
            type: "string",
            description:
              "Optional hint describing what you want to extract (the tool returns fetched content; it does not generate an AI summary)."
          },
          max_chars: {
            type: "integer",
            description: `Maximum content length (default: ${defaultMaxChars}).`
          },
          offset: {
            type: "integer",
            description: "Cursor read offset in characters (default: 0)."
          },
          limit: {
            type: "integer",
            description: "Cursor read limit in characters (default: max_chars)."
          }
        },
        anyOf: [{ required: ["url"] }, { required: ["cursor"] }]
      }
    };
  }
}
