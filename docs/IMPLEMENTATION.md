# EnriWeb MCP - Implementation Specification

> **Version**: 1.0.0  
> **Status**: Design Document  
> **Last Updated**: 2026-01-07 13:50 -06:00

This document provides a complete specification for implementing EnriWeb, enabling any LLM to build it correctly.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Project Structure](#3-project-structure)
4. [EnriProxy Endpoints (Required)](#4-enriproxy-endpoints-required)
5. [MCP Tools Specification](#5-mcp-tools-specification)
6. [Implementation Details](#6-implementation-details)
7. [Configuration](#7-configuration)
8. [Error Handling](#8-error-handling)
9. [Testing Requirements](#9-testing-requirements)
10. [Package Configuration](#10-package-configuration)
11. [Reference Implementation (EnriVision)](#11-reference-implementation-enrivision)

---

## 1. Overview

### 1.1 What is EnriWeb?

EnriWeb is a **client-side MCP server** that provides web search and URL fetching capabilities to MCP-compatible clients (Claude Desktop, Claude Code CLI, Cursor, Windsurf, VS Code, etc.) by delegating to EnriProxy's robust backend services.

### 1.2 Design Philosophy

EnriWeb follows the same architectural pattern as EnriVision:

- **Thin client**: Minimal logic in the MCP, delegates heavy work to EnriProxy
- **Universal compatibility**: Works with any MCP-compatible client
- **Backend robustness**: Leverages EnriProxy's multi-tier fallback chains

### 1.3 Why EnriWeb exists

EnriProxy already has sophisticated web services:

| Service | Capabilities |
|---------|--------------|
| **WebSearchService** | Tiered fallback across multiple search backends (details intentionally not exposed) |
| **WebFetchService** | Tiered fallback across multiple retrieval strategies (details intentionally not exposed) |

EnriWeb exposes these services as MCP tools, making them available to any MCP client without duplicating the implementation.

---

## 2. Architecture

### 2.1 System Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         MCP Client (Claude, Cursor, etc.)               │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ stdio (JSON-RPC 2.0)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           EnriWeb (MCP Server)                          │
│                                                                         │
│  ┌─────────────────┐    ┌─────────────────┐    ┌──────────────────┐   │
│  │  WebSearchTool  │    │  WebFetchTool   │    │  EnriProxyClient │   │
│  │                 │    │                 │    │                  │   │
│  │  • parseParams  │    │  • parseParams  │    │  • webSearch()   │   │
│  │  • execute()    │────│  • execute()    │────│  • webFetch()    │   │
│  └─────────────────┘    └─────────────────┘    └────────┬─────────┘   │
│                                                          │             │
└──────────────────────────────────────────────────────────┼─────────────┘
                                                           │ HTTP/HTTPS
                                                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                              EnriProxy                                   │
│                                                                         │
│  ┌───────────────────────────────┐  ┌────────────────────────────────┐ │
│  │  POST /v1/tools/web_search    │  │  POST /v1/tools/web_fetch      │ │
│  │                               │  │                                │ │
│  │  → WebSearchService           │  │  → WebFetchService             │ │      
│  │    • Search backends          │  │    • Registry APIs             │ │      
│  │    • Fallback chain           │  │    • Raw files                 │ │      
│  └───────────────────────────────┘  │    • Native fetch              │ │      
│                                      │    • Fallback chain            │ │     
│                                      │    • Browser automation        │ │     
│                                      └────────────────────────────────┘ │     
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Flow Example (web_search)

1. Client invokes `mcp__enriweb__web_search` with `{ "query": "typescript best practices" }`
2. EnriWeb receives JSON-RPC `tools/call` request
3. `WebSearchTool.parseParams()` validates and normalizes input
4. `WebSearchTool.execute()` calls `EnriProxyClient.webSearch()`
5. `EnriProxyClient` sends `POST /v1/tools/web_search` to EnriProxy
6. EnriProxy's `WebSearchService` executes multi-tier search
7. Results flow back through the chain
8. EnriWeb returns structured MCP response to client

---

## 3. Project Structure

```
EnriWeb/
├── docs/
│   └── IMPLEMENTATION.md          # This document
├── src/
│   ├── index.ts                   # Entrypoint: starts MCP server on stdio
│   ├── server/
│   │   └── EnriWebServer.ts       # MCP server with tool handlers
│   ├── tools/
│   │   ├── WebSearchTool.ts       # web_search tool implementation
│   │   └── WebFetchTool.ts        # web_fetch tool implementation
│   ├── client/
│   │   └── EnriProxyClient.ts     # HTTP client for EnriProxy endpoints
│   └── shared/
│       └── validation.ts          # Input validation utilities
├── tests/
│   ├── WebSearchTool.test.ts
│   ├── WebFetchTool.test.ts
│   └── EnriProxyClient.test.ts
├── package.json
├── tsconfig.json
└── LICENSE
```

---

## 4. EnriProxy Endpoints (Required)

EnriWeb requires two new HTTP endpoints in EnriProxy. These must be implemented before EnriWeb can function.

### 4.1 POST /v1/tools/web_search

**Request:**

```typescript
interface WebSearchRequestBody {
  /**
   * Search query string.
   */
  query: string;

  /**
   * Maximum number of results (1-25, default: 10).
   */
  max_results?: number;

  /**
   * Recency filter: "oneDay" | "oneWeek" | "oneMonth" | "oneYear" | "noLimit"
   */
  recency?: string;

  /**
   * Allowed domains filter (only return results from these domains).
   */
  allowed_domains?: string[];

  /**
   * Blocked domains filter (exclude results from these domains).
   */
  blocked_domains?: string[];

  /**
   * Search context/prompt to help refine results.
   */
  search_prompt?: string;
}
```

**Response:**

```typescript
interface WebSearchResponseBody {
  /**
   * Search results array.
   */
  results: Array<{
    /**
     * Result URL.
     */
    url: string;

    /**
     * Result title.
     */
    title?: string;

    /**
     * Result snippet/description.
     */
    snippet?: string;

    /**
     * Publication date (if available).
     */
    published_at?: string;
  }>;

  /**
   * Number of results returned.
   */
  count: number;
}
```

**Implementation in EnriProxy:**

The endpoint should:
1. Validate input
2. Create `WebSearchOptions` object
3. Call `webSearchService.executeWebSearch(options)`
4. Return formatted response

### 4.2 POST /v1/tools/web_fetch

**Request:**

```typescript
interface WebFetchRequestBody {
  /**
   * URL to fetch.
   */
  url: string;

  /**
   * Optional prompt/instructions for content extraction.
   */
  prompt?: string;

  /**
   * Maximum content length in characters.
   *
   * Notes:
   * - EnriProxy tool default: `web.fetch.tool_preview_chars` (default: 200000) when caller omits max_chars
   * - EnriProxy can internally capture more content via `web.fetch.capture_chars` and expose it through cursor pagination
   * - EnriWeb default: ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS (default: 200000)
   */
  max_chars?: number;
}
```

**Response:**

```typescript
interface WebFetchResponseBody {
  /**
   * Fetched content (text, markdown, or HTML depending on response).
   */
  content: string;

  /**
   * HTTP status code from the fetch.
   */
  status: number;

  /**
   * Content type of the response.
   */
  content_type: string;

  /**
   * Whether content was truncated.
   */
  truncated: boolean;
}
```

**Implementation in EnriProxy:**

The endpoint should:
1. Validate URL (must be HTTP/HTTPS)
2. Create `WebFetchOptions` object
3. Call `webFetchService.executeWebFetch(options)`
4. Return formatted response or error

---

## 5. MCP Tools Specification

### 5.1 Tool: web_search

**Name:** `web_search`

**Description:**
```
Search the web via EnriProxy's multi-tier search service.

When to use:
- When you need to find current information, news, or documentation.
- When searching for technical solutions, APIs, or code examples.
- When you need to verify facts or find up-to-date sources.

Features:
- Automatic fallback across multiple search backends (details intentionally not exposed)
- Domain filtering (allowlist/blocklist)
- Recency filtering (day/week/month/year)
- International results support

Notes:
- Provide specific, well-formed queries for best results.
- Use recency filter for time-sensitive information.
- Use domain filters to focus on authoritative sources.
```

**Input Schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string",
      "description": "Search query. Be specific for better results."
    },
    "max_results": {
      "type": "integer",
      "description": "Maximum number of results to return (1-25, default: 10)."
    },
    "recency": {
      "type": "string",
      "enum": ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"],
      "description": "Filter results by recency. Default: noLimit."
    },
    "allowed_domains": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Only return results from these domains (e.g., ['docs.microsoft.com', 'developer.mozilla.org'])."
    },
    "blocked_domains": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Exclude results from these domains."
    },
    "search_prompt": {
      "type": "string",
      "description": "Optional context to help refine search intent."
    }
  },
  "required": ["query"]
}
```

**Output:**

```
SEARCH RESULTS (N found):

1. [Title]
   URL: https://...
   Snippet: ...

2. [Title]
   URL: https://...
   Snippet: ...
...
```

### 5.2 Tool: web_fetch

**Name:** `web_fetch`

**Description:**
```
Fetch and read content from a URL via EnriProxy's multi-tier fetch service.

When to use:
- When you need to read the full content of a webpage.
- When you need to access documentation, articles, or code files.
- When simpler fetch methods fail due to anti-bot protection.

Features:
- 6-tier fallback chain for maximum reliability
- Anti-bot handling for protected sites (best-effort)
- Package registry API detection (npm, PyPI - bypasses anti-bot)
- Raw file detection (GitHub raw, HuggingFace)
- Additional fallback strategies (best-effort)

Notes:
- Provide the full URL including protocol (https://).
- Content is limited by the `max_chars` parameter (EnriWeb default: `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS`, default: 200000).
- If the response includes a `cursor`, call `web_fetch` again with `cursor` + `offset` + `limit` to read more without re-fetching.
- Protected sites may take longer due to fallback chain.
```

**Input Schema (JSON Schema):**

```json
{
  "type": "object",
  "properties": {
    "url": {
      "type": "string",
      "description": "Full URL to fetch (must be http:// or https://)."
    },
    "cursor": {
      "type": "string",
      "description": "Opaque cursor returned by a previous web_fetch call for pagination."
    },
    "prompt": {
      "type": "string",
      "description": "Optional extraction hint (the tool returns fetched content, not an AI summary)."
    },
    "max_chars": {
      "type": "integer",
      "description": "Maximum content length in characters (default: ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS, default: 200000)."
    },
    "offset": {
      "type": "integer",
      "description": "Cursor read offset in characters (default: 0)."
    },
    "limit": {
      "type": "integer",
      "description": "Cursor read limit in characters (default: max_chars)."
    }
  },
  "anyOf": [
    { "required": ["url"] },
    { "required": ["cursor"] }
  ]
}
```

**Output:**

```
CONTENT from https://example.com (text/html, 45230 chars):

[Content here...]
```

---

## 6. Implementation Details

### 6.1 src/index.ts (Entrypoint)

```typescript
#!/usr/bin/env node
/**
 * ENRIWEB - MCP ENTRYPOINT
 *
 * Starts the EnriWeb MCP server on stdio.
 *
 * @module index
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { EnriProxyClient } from "./client/EnriProxyClient.js";
import { WebSearchTool } from "./tools/WebSearchTool.js";
import { WebFetchTool } from "./tools/WebFetchTool.js";
import { EnriWebServer } from "./server/EnriWebServer.js";

/**
 * Environment variable for EnriProxy base URL.
 */
const ENRIPROXY_URL_ENV = "ENRIPROXY_URL";

/**
 * Environment variable for EnriProxy API key.
 */
const ENRIPROXY_API_KEY_ENV = "ENRIPROXY_API_KEY";

/**
 * Environment variable for default request timeout in milliseconds.
 */
const ENRIWEB_TIMEOUT_MS_ENV = "ENRIWEB_TIMEOUT_MS";

/**
 * Default EnriProxy URL used when env is not set.
 */
const DEFAULT_ENRIPROXY_URL = "http://127.0.0.1:8787";

/**
 * Default request timeout in milliseconds.
 */
const DEFAULT_TIMEOUT_MS = 60 * 1000; // 60 seconds

/**
 * Entry point for the MCP server.
 */
async function main(): Promise<void> {
  const serverUrl = (process.env[ENRIPROXY_URL_ENV] ?? DEFAULT_ENRIPROXY_URL).trim();
  const apiKey = (process.env[ENRIPROXY_API_KEY_ENV] ?? "").trim();
  const timeoutMsRaw = (process.env[ENRIWEB_TIMEOUT_MS_ENV] ?? "").trim();
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : DEFAULT_TIMEOUT_MS;

  const createClient = (baseUrl: string, key: string, timeout: number) =>
    new EnriProxyClient({
      baseUrl,
      apiKey: key,
      timeoutMs: timeout
    });

  const webSearchTool = new WebSearchTool({
    createClient,
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  });

  const webFetchTool = new WebFetchTool({
    createClient,
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS
  });

  const server = new EnriWebServer({
    name: "enriweb",
    version: "0.1.0",
    webSearchTool,
    webFetchTool
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("enriweb: MCP server running on stdio");
}

void main().catch((error: unknown) => {
  console.error("enriweb: fatal error", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
```

### 6.2 src/client/EnriProxyClient.ts

```typescript
/**
 * ENRIPROXY CLIENT
 *
 * Minimal HTTP client for EnriProxy web tool endpoints:
 * - POST /v1/tools/web_search
 * - POST /v1/tools/web_fetch
 *
 * @module client/EnriProxyClient
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

/**
 * Connection configuration for {@link EnriProxyClient}.
 */
export interface EnriProxyClientConfig {
  /**
   * EnriProxy base URL (e.g., https://proxy.example.com).
   */
  readonly baseUrl: string;

  /**
   * EnriProxy API key (sent as Authorization: Bearer ...).
   */
  readonly apiKey: string;

  /**
   * Default request timeout in milliseconds.
   */
  readonly timeoutMs: number;
}

/**
 * Web search request parameters.
 */
export interface WebSearchRequest {
  readonly query: string;
  readonly maxResults?: number;
  readonly recency?: string;
  readonly allowedDomains?: string[];
  readonly blockedDomains?: string[];
  readonly searchPrompt?: string;
}

/**
 * Web search result entry.
 */
export interface WebSearchResultEntry {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly published_at?: string;
}

/**
 * Web search response.
 */
export interface WebSearchResponse {
  readonly results: WebSearchResultEntry[];
  readonly count: number;
}

/**
 * Web fetch request parameters.
 */
export interface WebFetchRequest {
  readonly url: string;
  readonly prompt?: string;
  readonly maxChars?: number;
}

/**
 * Web fetch response.
 */
export interface WebFetchResponse {
  readonly content: string;
  readonly status: number;
  readonly content_type: string;
  readonly truncated: boolean;
}

/**
 * Error thrown when EnriProxy returns a non-2xx HTTP response.
 */
export class EnriProxyHttpError extends Error {
  public readonly status: number;
  public readonly body: string;

  public constructor(message: string, status: number, body: string) {
    super(message);
    this.name = "EnriProxyHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Minimal client for EnriProxy HTTP endpoints.
 */
export class EnriProxyClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  public constructor(config: EnriProxyClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Executes a web search via EnriProxy.
   *
   * @param request - Search request parameters
   * @returns Search response
   */
  public async webSearch(request: WebSearchRequest): Promise<WebSearchResponse> {
    const url = this.buildUrl("/v1/tools/web_search");
    const payload: Record<string, unknown> = {
      query: request.query
    };

    if (request.maxResults !== undefined) {
      payload.max_results = request.maxResults;
    }
    if (request.recency) {
      payload.recency = request.recency;
    }
    if (request.allowedDomains && request.allowedDomains.length > 0) {
      payload.allowed_domains = request.allowedDomains;
    }
    if (request.blockedDomains && request.blockedDomains.length > 0) {
      payload.blocked_domains = request.blockedDomains;
    }
    if (request.searchPrompt) {
      payload.search_prompt = request.searchPrompt;
    }

    const result = await this.requestJson("POST", url, payload);
    return JSON.parse(result.body) as WebSearchResponse;
  }

  /**
   * Fetches URL content via EnriProxy.
   *
   * @param request - Fetch request parameters
   * @returns Fetch response
   */
  public async webFetch(request: WebFetchRequest): Promise<WebFetchResponse> {
    const url = this.buildUrl("/v1/tools/web_fetch");
    const payload: Record<string, unknown> = {
      url: request.url
    };

    if (request.prompt) {
      payload.prompt = request.prompt;
    }
    if (request.maxChars !== undefined) {
      payload.max_chars = request.maxChars;
    }

    const result = await this.requestJson("POST", url, payload);
    return JSON.parse(result.body) as WebFetchResponse;
  }

  private buildUrl(pathname: string): URL {
    return new URL(pathname, this.baseUrl);
  }

  private async requestJson(
    method: "POST",
    url: URL,
    jsonBody: Record<string, unknown>
  ): Promise<{ status: number; body: string }> {
    const body = JSON.stringify(jsonBody);
    const isHttps = url.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    return new Promise((resolve, reject) => {
      const req = reqFn(
        url,
        {
          method,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            Authorization: `Bearer ${this.apiKey}`
          }
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const responseBody = Buffer.concat(chunks).toString("utf8");
            const status = res.statusCode ?? 0;

            if (status < 200 || status >= 300) {
              reject(new EnriProxyHttpError(
                `EnriProxy request failed (HTTP ${status})`,
                status,
                responseBody
              ));
              return;
            }

            resolve({ status, body: responseBody });
          });
        }
      );

      req.on("error", reject);
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${this.timeoutMs}ms`));
      });

      req.write(body);
      req.end();
    });
  }
}
```

### 6.3 src/tools/WebSearchTool.ts

```typescript
/**
 * WEB SEARCH TOOL
 *
 * MCP tool that executes web searches via EnriProxy.
 *
 * @module tools/WebSearchTool
 */

import type { EnriProxyClient, WebSearchResponse } from "../client/EnriProxyClient.js";
import { assertNonEmptyString, assertObject, optionalInt, optionalString, optionalStringArray } from "../shared/validation.js";

/**
 * Tool parameters for `web_search`.
 */
export interface WebSearchToolParams {
  readonly query: string;
  readonly maxResults?: number;
  readonly recency?: string;
  readonly allowedDomains?: string[];
  readonly blockedDomains?: string[];
  readonly searchPrompt?: string;
}

/**
 * Tool result for `web_search`.
 */
export interface WebSearchToolResult {
  readonly results: Array<{
    readonly url: string;
    readonly title?: string;
    readonly snippet?: string;
    readonly published_at?: string;
  }>;
  readonly count: number;
}

/**
 * Dependencies for {@link WebSearchTool}.
 */
export interface WebSearchToolDeps {
  readonly createClient: (serverUrl: string, apiKey: string, timeoutMs: number) => EnriProxyClient;
  readonly defaultServerUrl: string;
  readonly defaultApiKey: string;
  readonly defaultTimeoutMs: number;
}

/**
 * MCP tool that executes web searches.
 */
export class WebSearchTool {
  private readonly deps: WebSearchToolDeps;

  public constructor(deps: WebSearchToolDeps) {
    this.deps = deps;
  }

  /**
   * Validates raw MCP tool arguments.
   *
   * @param raw - Raw tool arguments
   * @returns Validated parameters
   */
  public parseParams(raw: unknown): WebSearchToolParams {
    const obj = assertObject(raw, "arguments");

    const query = assertNonEmptyString(obj["query"], "query");
    const maxResults = optionalInt(obj["max_results"]);
    const recency = optionalString(obj["recency"]);
    const allowedDomains = optionalStringArray(obj["allowed_domains"]);
    const blockedDomains = optionalStringArray(obj["blocked_domains"]);
    const searchPrompt = optionalString(obj["search_prompt"]);

    // Validate recency if provided
    if (recency) {
      const validRecency = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"];
      if (!validRecency.includes(recency)) {
        throw new Error(`recency must be one of: ${validRecency.join(", ")}`);
      }
    }

    // Validate maxResults range
    if (maxResults !== undefined && (maxResults < 1 || maxResults > 25)) {
      throw new Error("max_results must be between 1 and 25");
    }

    return {
      query,
      maxResults,
      recency,
      allowedDomains,
      blockedDomains,
      searchPrompt
    };
  }

  /**
   * Executes the web search tool.
   *
   * @param params - Validated parameters
   * @returns Tool result
   */
  public async execute(params: WebSearchToolParams): Promise<WebSearchToolResult> {
    const serverUrl = assertHttpUrl(this.deps.defaultServerUrl, "ENRIPROXY_URL");
    const apiKey = assertNonEmptyString(this.deps.defaultApiKey, "ENRIPROXY_API_KEY");

    const client = this.deps.createClient(serverUrl, apiKey, this.deps.defaultTimeoutMs);

    const response = await client.webSearch({
      query: params.query,
      maxResults: params.maxResults,
      recency: params.recency,
      allowedDomains: params.allowedDomains,
      blockedDomains: params.blockedDomains,
      searchPrompt: params.searchPrompt
    });

    return {
      results: response.results,
      count: response.count
    };
  }

  /**
   * Formats results for MCP text output.
   *
   * @param result - Tool result
   * @returns Formatted text
   */
  public formatOutput(result: WebSearchToolResult): string {
    if (result.count === 0) {
      return "No search results found.";
    }

    const lines: string[] = [`SEARCH RESULTS (${result.count} found):\n`];

    for (let i = 0; i < result.results.length; i++) {
      const r = result.results[i]!;
      lines.push(`${i + 1}. ${r.title ?? "(No title)"}`);
      lines.push(`   URL: ${r.url}`);
      if (r.snippet) {
        lines.push(`   ${r.snippet}`);
      }
      if (r.published_at) {
        lines.push(`   Published: ${r.published_at}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
```

### 6.4 src/tools/WebFetchTool.ts

```typescript
/**
 * WEB FETCH TOOL
 *
 * MCP tool that fetches URL content via EnriProxy.
 *
 * @module tools/WebFetchTool
 */

import type { EnriProxyClient, WebFetchResponse } from "../client/EnriProxyClient.js";
import { assertNonEmptyString, assertObject, assertHttpUrl, optionalInt, optionalString } from "../shared/validation.js";

/**
 * Tool parameters for `web_fetch`.
 */
export interface WebFetchToolParams {
  readonly url: string;
  readonly prompt?: string;
  readonly maxChars?: number;
}

/**
 * Tool result for `web_fetch`.
 */
export interface WebFetchToolResult {
  readonly content: string;
  readonly status: number;
  readonly content_type: string;
  readonly truncated: boolean;
  readonly url: string;
}

/**
 * Dependencies for {@link WebFetchTool}.
 */
export interface WebFetchToolDeps {
  readonly createClient: (serverUrl: string, apiKey: string, timeoutMs: number) => EnriProxyClient;
  readonly defaultServerUrl: string;
  readonly defaultApiKey: string;
  readonly defaultTimeoutMs: number;
}

/**
 * MCP tool that fetches URL content.
 */
export class WebFetchTool {
  private readonly deps: WebFetchToolDeps;

  public constructor(deps: WebFetchToolDeps) {
    this.deps = deps;
  }

  /**
   * Validates raw MCP tool arguments.
   *
   * @param raw - Raw tool arguments
   * @returns Validated parameters
   */
  public parseParams(raw: unknown): WebFetchToolParams {
    const obj = assertObject(raw, "arguments");

    const urlRaw = assertNonEmptyString(obj["url"], "url");
    const url = assertHttpUrl(urlRaw, "url");
    const prompt = optionalString(obj["prompt"]);
    const maxChars = optionalInt(obj["max_chars"]);

    // Validate maxChars range
    if (maxChars !== undefined && maxChars < 1) {
      throw new Error("max_chars must be positive");
    }

    return {
      url,
      prompt,
      maxChars
    };
  }

  /**
   * Executes the web fetch tool.
   *
   * @param params - Validated parameters
   * @returns Tool result
   */
  public async execute(params: WebFetchToolParams): Promise<WebFetchToolResult> {
    const serverUrl = assertHttpUrl(this.deps.defaultServerUrl, "ENRIPROXY_URL");
    const apiKey = assertNonEmptyString(this.deps.defaultApiKey, "ENRIPROXY_API_KEY");

    const client = this.deps.createClient(serverUrl, apiKey, this.deps.defaultTimeoutMs);

    const response = await client.webFetch({
      url: params.url,
      prompt: params.prompt,
      maxChars: params.maxChars
    });

    return {
      content: response.content,
      status: response.status,
      content_type: response.content_type,
      truncated: response.truncated,
      url: params.url
    };
  }

  /**
   * Formats results for MCP text output.
   *
   * @param result - Tool result
   * @returns Formatted text
   */
  public formatOutput(result: WebFetchToolResult): string {
    const truncatedNote = result.truncated ? " [TRUNCATED]" : "";
    const header = `CONTENT from ${result.url} (${result.content_type}, ${result.content.length} chars)${truncatedNote}:\n\n`;
    return header + result.content;
  }
}
```

### 6.5 src/server/EnriWebServer.ts

```typescript
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
  readonly name: string;
  readonly version: string;
  readonly webSearchTool: WebSearchTool;
  readonly webFetchTool: WebFetchTool;
}

/**
 * MCP server exposing EnriWeb tools.
 */
export class EnriWebServer {
  private readonly server: Server;
  private readonly webSearchTool: WebSearchTool;
  private readonly webFetchTool: WebFetchTool;

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

  public async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

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
            description: "Maximum results (1-25, default: 10)."
          },
          recency: {
            type: "string",
            description: "Filter by recency: oneDay, oneWeek, oneMonth, oneYear, noLimit."
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

  private getWebFetchToolDefinition(): Tool {
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
        "- 6-tier fallback chain for maximum reliability\n" +
        "- Anti-bot handling for protected sites (best-effort)\n" +
        "- Package registry API detection (npm, PyPI)\n" +
        "- Additional fallback strategies (best-effort)\n" +
        "\n" +
        "Notes:\n" +
        "- Provide the full URL including protocol (https://).\n" +
        "- Content is limited by the `max_chars` parameter (default: ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS, default: 200000).",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Full URL to fetch (http:// or https://)."
          },
          prompt: {
            type: "string",
            description: "Optional extraction hint (the tool returns fetched content, not an AI summary)."
          },
          max_chars: {
            type: "integer",
            description: "Maximum content length (default: ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS, default: 200000)."
          }
        },
        required: ["url"]
      }
    };
  }
}
```

### 6.6 src/shared/validation.ts

```typescript
/**
 * INPUT VALIDATION UTILITIES
 *
 * @module shared/validation
 */

/**
 * Asserts that value is a non-null object.
 *
 * @param value - Value to check
 * @param name - Parameter name for error messages
 * @returns Value as Record
 * @throws Error if not an object
 */
export function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Asserts that value is a non-empty string.
 *
 * @param value - Value to check
 * @param name - Parameter name for error messages
 * @returns Trimmed string
 * @throws Error if not a non-empty string
 */
export function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required and must be a non-empty string.`);
  }
  return value.trim();
}

/**
 * Asserts that value is a valid HTTP/HTTPS URL.
 *
 * @param value - Value to check
 * @param name - Parameter name for error messages
 * @returns URL string
 * @throws Error if not a valid HTTP/HTTPS URL
 */
export function assertHttpUrl(value: string, name: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`${name} must be an HTTP or HTTPS URL.`);
    }
    return value;
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
}

/**
 * Returns trimmed string or undefined.
 *
 * @param value - Value to check
 * @returns Trimmed string or undefined
 */
export function optionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

/**
 * Returns integer or undefined.
 *
 * @param value - Value to check
 * @returns Integer or undefined
 */
export function optionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Returns string array or undefined.
 *
 * @param value - Value to check
 * @returns String array or undefined
 */
export function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      result.push(item.trim());
    }
  }
  return result.length > 0 ? result : undefined;
}
```

---

## 7. Configuration

### 7.1 Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ENRIPROXY_URL` | Yes | `http://127.0.0.1:8787` | EnriProxy base URL |
| `ENRIPROXY_API_KEY` | Yes | - | EnriProxy API key |
| `ENRIWEB_TIMEOUT_MS` | No | `60000` | Request timeout in milliseconds |

### 7.2 Client Configuration Examples

**Claude Desktop / Claude Code CLI:**

```json
{
  "mcpServers": {
    "enriweb": {
      "command": "npx",
      "args": ["-y", "@bedolla/enriweb"],
      "env": {
        "ENRIPROXY_URL": "https://your-enriproxy.example.com",
        "ENRIPROXY_API_KEY": "your-api-key"
      }
    }
  }
}
```

**Cursor / Windsurf:**

Same format, placed in the appropriate MCP configuration file.

---

## 8. Error Handling

### 8.1 Error Types

| Error | HTTP Status | Cause | User Message |
|-------|-------------|-------|--------------|
| Validation Error | - | Invalid input | "query is required and must be a non-empty string." |
| Auth Error | 401/403 | Invalid API key | "EnriProxy authentication failed. Check ENRIPROXY_API_KEY." |
| Timeout | - | Request timeout | "Request timed out after 60000ms." |
| Server Error | 500+ | EnriProxy error | "EnriProxy request failed (HTTP 500)." |
| No Results | 200 | Empty search | "No search results found." |
| Fetch Failed | 200 | All tiers failed | "Failed to fetch URL content after all fallback tiers." |

### 8.2 Error Response Format

Errors are returned as MCP `CallToolResult` with `isError: true`:

```typescript
{
  isError: true,
  content: [{ type: "text", text: "Error message here" }]
}
```

---

## 9. Testing Requirements

### 9.1 Unit Tests

**WebSearchTool.test.ts:**
- `parseParams()` validation tests
  - Valid query
  - Missing query
  - Invalid recency value
  - Invalid maxResults range
  - Domain list parsing

**WebFetchTool.test.ts:**
- `parseParams()` validation tests
  - Valid URL
  - Invalid URL (not HTTP/HTTPS)
  - Missing URL

**EnriProxyClient.test.ts:**
- Mock HTTP responses
- Error handling for non-2xx responses
- Timeout handling

### 9.2 Integration Tests

- End-to-end flow with mock EnriProxy server
- MCP protocol compliance (ListToolsRequest, CallToolRequest)

---

## 10. Package Configuration

### 10.1 package.json

```json
{
  "name": "@bedolla/enriweb",
  "version": "0.1.0",
  "description": "MCP server that provides web search and URL fetching via EnriProxy.",
  "license": "AGPL-3.0-only",
  "author": "Pipochas",
  "type": "module",
  "bin": {
    "enriweb": "dist/index.js"
  },
  "files": [
    "dist",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.25.1"
  },
  "devDependencies": {
    "@types/node": "25.0.3",
    "typescript": "5.9.3",
    "vitest": "4.0.16"
  },
  "engines": {
    "node": ">=24"
  }
}
```

### 10.2 tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "lib": ["ES2022"],
    "types": ["node"],
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "removeComments": false,
    "allowUnreachableCode": false,
    "allowUnusedLabels": false,
    "exactOptionalPropertyTypes": false,
    "strict": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 11. Reference Implementation (EnriVision)

EnriWeb follows the exact architectural pattern established by EnriVision:

| Aspect | EnriVision | EnriWeb |
|--------|------------|---------|
| Purpose | Media analysis | Web search/fetch |
| Tools | `analyze_media` | `web_search`, `web_fetch` |
| EnriProxy endpoints | `/v1/uploads`, `/v1/vision/analyze` | `/v1/tools/web_search`, `/v1/tools/web_fetch` |
| Client | `EnriProxyClient.ts` | `EnriProxyClient.ts` |
| Tool classes | `AnalyzeMediaTool.ts` | `WebSearchTool.ts`, `WebFetchTool.ts` |
| Server | `EnriVisionServer.ts` | `EnriWebServer.ts` |

For implementation reference, see:
- `EnriVision/src/index.ts` - Entrypoint pattern
- `EnriVision/src/server/EnriVisionServer.ts` - MCP server pattern
- `EnriVision/src/tools/AnalyzeMediaTool.ts` - Tool implementation pattern
- `EnriVision/src/client/EnriProxyClient.ts` - HTTP client pattern

---

## Implementation Checklist

### Phase 1: EnriProxy Endpoints (Prerequisite)

- [ ] Implement `POST /v1/tools/web_search` endpoint
- [ ] Implement `POST /v1/tools/web_fetch` endpoint
- [ ] Add authentication handling for new endpoints
- [ ] Add request validation
- [ ] Write endpoint tests

### Phase 2: EnriWeb MCP

- [ ] Create project structure
- [ ] Implement `src/shared/validation.ts`
- [ ] Implement `src/client/EnriProxyClient.ts`
- [ ] Implement `src/tools/WebSearchTool.ts`
- [ ] Implement `src/tools/WebFetchTool.ts`
- [ ] Implement `src/server/EnriWebServer.ts`
- [ ] Implement `src/index.ts`
- [ ] Write unit tests
- [ ] Write integration tests
- [ ] Configure package.json and tsconfig.json

### Phase 3: Testing & Publication

- [ ] Test with Claude Desktop
- [ ] Test with Claude Code CLI
- [ ] Test with Cursor (if available)
- [ ] Publish to npm (optional)

---

## Appendix: MCP Protocol Reference

EnriWeb uses the Model Context Protocol (MCP) standard:

- **Transport**: stdio (stdin/stdout)
- **Protocol**: JSON-RPC 2.0
- **Key methods**:
  - `tools/list` - Returns available tools
  - `tools/call` - Invokes a tool with arguments

For full MCP specification, see: https://modelcontextprotocol.io/
