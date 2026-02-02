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
import { WebSearchRegistryVerifier } from "./tools/WebSearchRegistryVerifier.js";
import { EnriWebServer } from "./server/EnriWebServer.js";
import { packageInfoService } from "./package-info.js";

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
 * Environment variable for the default `web_fetch` max_chars limit.
 */
const ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS_ENV =
  "ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS";

/**
 * Environment variable for an optional GitHub token used by `web_search`
 * enrichment to improve GitHub API rate limits.
 */
const ENRIWEB_GITHUB_TOKEN_ENV = "ENRIWEB_GITHUB_TOKEN";

/**
 * Default EnriProxy URL used when env is not set.
 */
const DEFAULT_ENRIPROXY_URL = "http://127.0.0.1:8787";

/**
 * Default request timeout in milliseconds.
 */
const DEFAULT_TIMEOUT_MS = 60 * 1000;

/**
 * Default maximum `web_fetch` content length.
 *
 * @remarks
 * This aligns with EnriProxy's tool-preview defaults to reduce the risk of MCP
 * tool-result truncation in clients that enforce output token limits.
 *
 * Note: Some MCP clients enforce tool-result token limits (for example Claude
 * Code CLI limits like MAX_MCP_OUTPUT_TOKENS=32000). Large outputs may be
 * truncated by the client or written to a tool-results file for paging.       
 */
const DEFAULT_WEB_FETCH_MAX_CHARS = 200_000;

/**
 * Default timeout (ms) for registry enrichment requests.
 */
const DEFAULT_REGISTRY_TIMEOUT_MS = 15_000;

/**
 * Default cache TTL (ms) for registry enrichment.
 */
const DEFAULT_REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Default maximum entities verified per `web_search` call.
 */
const DEFAULT_REGISTRY_MAX_ENTITIES_PER_CALL = 6;

/**
 * Entry point for the MCP server.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    console.log("EnriWeb");
    console.log("");
    console.log("This is an MCP server over stdio that provides web search and URL fetching via EnriProxy.");
    console.log("");
    console.log("Usage:");
    console.log("  enriweb              (start MCP server over stdio)");
    console.log("  enriweb --version");
    console.log("  enriweb --help");
    console.log("");
    console.log("Environment variables:");
    console.log("  ENRIPROXY_URL (optional, default: http://127.0.0.1:8787)");
    console.log("  ENRIPROXY_API_KEY (required)");
    console.log("  ENRIWEB_TIMEOUT_MS (optional, default: 60000)");
    console.log("  ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS (optional, default: 200000)");
    console.log("  ENRIWEB_GITHUB_TOKEN (optional, improves GitHub API rate limits)");
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    console.log(packageInfoService.getVersion());
    process.exit(0);
  }

  const serverUrl = (process.env[ENRIPROXY_URL_ENV] ?? DEFAULT_ENRIPROXY_URL).trim();
  const apiKey = (process.env[ENRIPROXY_API_KEY_ENV] ?? "").trim();
  const timeoutMsRaw = (process.env[ENRIWEB_TIMEOUT_MS_ENV] ?? "").trim();
  const defaultWebFetchMaxCharsRaw = (
    process.env[ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS_ENV] ?? ""
  ).trim();
  const timeoutMs = timeoutMsRaw ? Number.parseInt(timeoutMsRaw, 10) : DEFAULT_TIMEOUT_MS;
  const defaultWebFetchMaxChars = defaultWebFetchMaxCharsRaw
    ? Number.parseInt(defaultWebFetchMaxCharsRaw, 10)
    : DEFAULT_WEB_FETCH_MAX_CHARS;
  const githubToken = (process.env[ENRIWEB_GITHUB_TOKEN_ENV] ?? "").trim();

  const createClient = (baseUrl: string, key: string, timeout: number): EnriProxyClient =>
    new EnriProxyClient({
      baseUrl,
      apiKey: key,
      timeoutMs: timeout
    });

  const resolvedTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const resolvedDefaultWebFetchMaxChars: number =
    Number.isFinite(defaultWebFetchMaxChars) && defaultWebFetchMaxChars > 0
      ? defaultWebFetchMaxChars
      : DEFAULT_WEB_FETCH_MAX_CHARS;

  const webSearchTool = new WebSearchTool({
    createClient,
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: resolvedTimeoutMs,
    registryVerifier: new WebSearchRegistryVerifier({
      fetchImpl: fetch,
      timeoutMs: DEFAULT_REGISTRY_TIMEOUT_MS,
      cacheTtlMs: DEFAULT_REGISTRY_CACHE_TTL_MS,
      maxEntitiesPerCall: DEFAULT_REGISTRY_MAX_ENTITIES_PER_CALL,
      githubToken: githubToken.length > 0 ? githubToken : undefined
    })
  });

  const webFetchTool = new WebFetchTool({
    createClient,
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: resolvedTimeoutMs,
    defaultMaxChars: resolvedDefaultWebFetchMaxChars
  });

  const server = new EnriWebServer({
    name: "EnriWeb",
    version: packageInfoService.getVersion(),
    webSearchTool,
    webFetchTool
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[EnriWeb] MCP server running on stdio");
}

void main().catch((error: unknown) => {
  console.error("[EnriWeb] FATAL:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
