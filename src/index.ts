#!/usr/bin/env node
/**
 * ENRIWEB - MCP ENTRYPOINT
 *
 * Starts the EnriWeb MCP server on stdio.
 *
 * @module index
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { EnriProxyClient, MAX_WIRE_MAX_CHARS } from "./client/EnriProxyClient.js";
import { parseSearchEnginesEnv, SEARCH_ENGINES_ENV } from "./shared/operatorSearchEngines.js";
import { WebSearchTool } from "./tools/WebSearchTool.js";
import { WebFetchTool } from "./tools/WebFetchTool.js";
import { WebSearchRegistryVerifier } from "./tools/WebSearchRegistryVerifier.js";
import { EnriWebServer } from "./server/EnriWebServer.js";
import { packageInfoService } from "./package-info.js";
import { assertHttpUrl } from "./shared/validation.js";

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
 * Environment variable for the `web_search` request timeout in milliseconds.
 */
const ENRIWEB_SEARCH_TIMEOUT_MS_ENV = "ENRIWEB_SEARCH_TIMEOUT_MS";

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
 * Installation-level default screenshot mode for `web_fetch` (applies when
 * the host omits the parameter). Designed for clients whose provider rejects
 * image blocks inside tool results (OpenAI-compatible Chat Completions) —
 * `analyze` converts captures to server-side text descriptions.
 */
const ENRIWEB_SCREENSHOT_MODE_ENV = "ENRIWEB_SCREENSHOT_MODE";
const VALID_SCREENSHOT_MODES: ReadonlySet<string> = new Set(["auto", "force", "none", "analyze"]);

/**
 * Default EnriProxy URL used when env is not set.
 */
const DEFAULT_ENRIPROXY_URL = "http://127.0.0.1:8888";

/**
 * Default `web_fetch` request timeout in milliseconds.
 *
 * @remarks
 * Five minutes: double EnriProxy's total fetch budget (150 s) so slow tier
 * chains (CycleTLS floor ~35 s, stealth renders, embedding-reducer cold
 * start) finish before the client gives up. Operator policy is a uniform
 * 5-minute tool budget for both tools (see DEFAULT_SEARCH_TIMEOUT_MS).
 */
const DEFAULT_FETCH_TIMEOUT_MS = 300 * 1000;

/**
 * Default `web_search` request timeout in milliseconds.
 *
 * @remarks
 * Uniform 5-minute operator tool budget (same as `web_fetch`). Batched
 * `queries` run in parallel server-side, so they do not multiply the worst
 * case. Honest residual, recorded by operator order: EnriProxy's SearXNG
 * budget alone can reach 310 s when slow engines are kept, so a search
 * slower than 300 s still ends in this retryable timeout; raise
 * `ENRIWEB_SEARCH_TIMEOUT_MS` to extend it.
 */
const DEFAULT_SEARCH_TIMEOUT_MS = 300 * 1000;

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
 * Upper character budget accepted for the `web_fetch` default.
 *
 * @remarks
 * The shared 4M wire ceiling (single source in the client) so the
 * environment cannot configure an unbounded default.
 */
const MAX_DEFAULT_WEB_FETCH_MAX_CHARS = MAX_WIRE_MAX_CHARS;

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
 * Parses one positive-integer environment value with strict digits.
 *
 * @param raw - Raw environment value, if set.
 * @param fallback - Default used when unset, blank, or invalid.
 * @returns Parsed value or the fallback.
 */
function parsePositiveIntEnv(raw: string | undefined, fallback: number): number {
  const trimmed: string = (raw ?? "").trim();
  if (!/^\d+$/u.test(trimmed)) {
    return fallback;
  }
  const parsed: number = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Entry point for the MCP server.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    console.log("EnriWeb");
    console.log("");
    console.log("Servidor MCP por stdio que provee búsqueda web y lectura de URLs vía EnriProxy.");
    console.log("");
    console.log("Uso:");
    console.log("  enriweb              (inicia el servidor MCP por stdio)");
    console.log("  enriweb --version");
    console.log("  enriweb --help");
    console.log("");
    console.log("Variables de entorno:");
    console.log("  ENRIPROXY_URL (opcional, default: http://127.0.0.1:8888)");
    console.log("  ENRIPROXY_API_KEY (requerida)");
    console.log("  ENRIWEB_TIMEOUT_MS (opcional, default: 300000, timeout de web_fetch)");
    console.log("  ENRIWEB_SEARCH_TIMEOUT_MS (opcional, default: 300000, timeout de web_search)");
    console.log("  ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS (opcional, default: 200000, máximo 4000000)");
    console.log("  ENRIWEB_GITHUB_TOKEN (opcional, mejora los límites de la API de GitHub)");
    console.log("  ENRIWEB_SEARCH_ENGINES (opcional, ej: google — motores SearXNG para todas las búsquedas)");
    process.exit(0);
  }

  if (args[0] === "--version" || args[0] === "-v" || args[0] === "version") {
    console.log(packageInfoService.getVersion());
    process.exit(0);
  }

  const serverUrl = (process.env[ENRIPROXY_URL_ENV] ?? DEFAULT_ENRIPROXY_URL).trim();
  const apiKey = (process.env[ENRIPROXY_API_KEY_ENV] ?? "").trim();
  if (!apiKey) {
    throw new Error("Falta ENRIPROXY_API_KEY: configure la API key de EnriProxy antes de iniciar el MCP.");
  }
  assertHttpUrl(serverUrl, ENRIPROXY_URL_ENV);
  const timeoutMs = parsePositiveIntEnv(process.env[ENRIWEB_TIMEOUT_MS_ENV], DEFAULT_FETCH_TIMEOUT_MS);
  const searchTimeoutMs = parsePositiveIntEnv(
    process.env[ENRIWEB_SEARCH_TIMEOUT_MS_ENV],
    DEFAULT_SEARCH_TIMEOUT_MS
  );
  const defaultWebFetchMaxChars = Math.min(
    parsePositiveIntEnv(process.env[ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS_ENV], DEFAULT_WEB_FETCH_MAX_CHARS),
    MAX_DEFAULT_WEB_FETCH_MAX_CHARS
  );
  const githubToken = (process.env[ENRIWEB_GITHUB_TOKEN_ENV] ?? "").trim();
  const defaultSearchEngines = parseSearchEnginesEnv(process.env[SEARCH_ENGINES_ENV]);

  const createClient = (baseUrl: string, key: string, timeout: number): EnriProxyClient =>
    new EnriProxyClient({
      baseUrl,
      apiKey: key,
      timeoutMs: timeout
    });

  const webSearchTool = new WebSearchTool({
    createClient,
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: searchTimeoutMs,
    defaultEngines: defaultSearchEngines,
    registryVerifier: new WebSearchRegistryVerifier({
      fetchImpl: fetch,
      timeoutMs: DEFAULT_REGISTRY_TIMEOUT_MS,
      cacheTtlMs: DEFAULT_REGISTRY_CACHE_TTL_MS,
      maxEntitiesPerCall: DEFAULT_REGISTRY_MAX_ENTITIES_PER_CALL,
      githubToken: githubToken.length > 0 ? githubToken : undefined
    })
  });

  const defaultScreenshotModeRaw = (process.env[ENRIWEB_SCREENSHOT_MODE_ENV] ?? "").trim().toLowerCase();
  const defaultScreenshotMode = VALID_SCREENSHOT_MODES.has(defaultScreenshotModeRaw)
    ? (defaultScreenshotModeRaw as "auto" | "force" | "none" | "analyze")
    : undefined;
  if (defaultScreenshotModeRaw.length > 0 && defaultScreenshotMode === undefined) {
    console.error(
      `[EnriWeb] Ignoring invalid ${ENRIWEB_SCREENSHOT_MODE_ENV}="${defaultScreenshotModeRaw}" (valid: auto, force, none, analyze)`,
    );
  }

  const webFetchTool = new WebFetchTool({
    createClient,
    defaultServerUrl: serverUrl,
    defaultApiKey: apiKey,
    defaultTimeoutMs: timeoutMs,
    defaultMaxChars: defaultWebFetchMaxChars,
    defaultScreenshotMode
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
