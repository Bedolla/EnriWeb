/**
 * WEB SEARCH TOOL
 *
 * Implements the `web_search` MCP tool by delegating to EnriProxy.
 *
 * @module tools/WebSearchTool
 */
import type {
  EnriProxyClient,
  WebSearchResultEntry
} from "../client/EnriProxyClient.js";
import type { VerifiedRegistryEntity } from "./WebSearchRegistryVerifier.js";
import type { WebSearchRegistryVerifier } from "./WebSearchRegistryVerifier.js";
import {
  assertHttpUrl,
  assertNonEmptyString,
  assertObject,
  optionalInt,
  optionalString,
  optionalStringArray
} from "../shared/validation.js";

/**
 * Supported recency filters.
 */
const RECENCY_VALUES = ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"] as const;

/**
 * Tool parameters for `web_search`.
 */
export interface WebSearchToolParams {
  /**
   * Search query string.
   */
  readonly query: string;

  /**
   * Maximum number of results.
   */
  readonly maxResults?: number;

  /**
   * Recency filter.
   */
  readonly recency?: (typeof RECENCY_VALUES)[number];

  /**
   * Allowed domains filter list.
   */
  readonly allowedDomains?: string[];

  /**
   * Blocked domains filter list.
   */
  readonly blockedDomains?: string[];

  /**
   * Optional search prompt context.
   */
  readonly searchPrompt?: string;
}

/**
 * Tool result for `web_search`.
 */
export interface WebSearchToolResult extends Record<string, unknown> {
  /**
   * Query that was executed.
   */
  readonly query: string;

  /**
   * Result list.
   */
  readonly results: WebSearchResultEntry[];

  /**
   * Number of results returned.
   */
  readonly count: number;

  /**
   * Optional verified registry data derived from canonical sources.
   */
  readonly verified?: VerifiedRegistryEntity[];
}

/**
 * Dependencies for {@link WebSearchTool}.
 */
export interface WebSearchToolDeps {
  /**
   * Creates an EnriProxy client with a base URL, API key, and timeout.
   *
   * @param serverUrl - EnriProxy URL
   * @param apiKey - EnriProxy API key
   * @param timeoutMs - Timeout in ms
   * @returns Client instance
   */
  readonly createClient: (serverUrl: string, apiKey: string, timeoutMs: number) => EnriProxyClient;

  /**
   * Default EnriProxy server URL.
   */
  readonly defaultServerUrl: string;

  /**
   * Default EnriProxy API key.
   */
  readonly defaultApiKey: string;

  /**
   * Default timeout in milliseconds.
   */
  readonly defaultTimeoutMs: number;

  /**
   * Registry verifier used to enrich search results with canonical versions.
   */
  readonly registryVerifier: WebSearchRegistryVerifier;
}

/**
 * MCP tool that performs web search via EnriProxy.
 */
export class WebSearchTool {
  /**
   * Tool dependencies.
   */
  private readonly deps: WebSearchToolDeps;

  /**
   * Creates a new {@link WebSearchTool}.
   *
   * @param deps - Tool dependencies
   */
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
    const recencyRaw = optionalString(obj["recency"]);
    const allowedDomains = optionalStringArray(obj["allowed_domains"]);
    const blockedDomains = optionalStringArray(obj["blocked_domains"]);
    const searchPrompt = optionalString(obj["search_prompt"]);

    if (maxResults !== undefined && maxResults < 1) {
      throw new Error("max_results debe ser al menos 1.");
    }

    let recency: WebSearchToolParams["recency"];
    if (recencyRaw) {
      const candidate = recencyRaw as (typeof RECENCY_VALUES)[number];
      if (!RECENCY_VALUES.includes(candidate)) {
        throw new Error("recency debe ser uno de: oneDay, oneWeek, oneMonth, oneYear, noLimit.");
      }
      recency = candidate;
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

    const verified = await this.deps.registryVerifier.verifyFromSearchResults(
      response.results
    );

    return {
      query: params.query,
      results: response.results,
      count: response.count,
      verified: verified.length > 0 ? verified : undefined
    };
  }

  /**
   * Formats results for MCP text output.
   *
   * @param result - Tool result
   * @returns Formatted text
   */
  public formatOutput(result: WebSearchToolResult): string {
    const header = `RESULTADOS DE BÚSQUEDA (${result.count} encontrados):\n\n`;
    if (!Array.isArray(result.results) || result.results.length === 0) {
      return `${header}No se encontraron resultados.`;
    }

    const lines = result.results.map((entry, index) => {
      const title = entry.title && entry.title.trim() ? entry.title.trim() : "(Sin título)";
      const snippet =
        entry.snippet && entry.snippet.trim() ? entry.snippet.trim() : "(Sin extracto)";
      return `${index + 1}. ${title}\n   URL: ${entry.url}\n   Extracto: ${snippet}`;
    });

    return header + lines.join("\n\n");
  }
}
