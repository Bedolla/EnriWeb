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
  /**
   * Search query string.
   */
  readonly query: string;

  /**
   * Batched search queries (1-4 non-blank strings). When present the proxy
   * executes every query concurrently and returns a merged, URL-deduplicated
   * result list; `query` remains the fallback for older proxies.
   */
  readonly queries?: string[];

  /**
   * Maximum number of results.
   */
  readonly maxResults?: number;

  /**
   * Recency filter.
   */
  readonly recency?: string;

  /**
   * Allowed domains filter.
   */
  readonly allowedDomains?: string[];

  /**
   * Blocked domains filter.
   */
  readonly blockedDomains?: string[];

  /**
   * Optional search prompt context.
   */
  readonly searchPrompt?: string;
}

/**
 * Web search result entry.
 */
export interface WebSearchResultEntry {
  /**
   * Result URL.
   */
  readonly url: string;

  /**
   * Result title.
   */
  readonly title?: string;

  /**
   * Result snippet.
   */
  readonly snippet?: string;

  /**
   * Optional publication date.
   */
  readonly published_at?: string;
}

/**
 * Web search response.
 */
export interface WebSearchResponse {
  /**
   * Search results array.
   */
  readonly results: WebSearchResultEntry[];

  /**
   * Number of results returned.
   */
  readonly count: number;

  /**
   * Executed batched queries reported by the proxy, when the request used them.
   */
  readonly queries?: string[];

  /**
   * Queries whose execution failed while at least one other query succeeded.
   */
  readonly failed_queries?: string[];
}

/**
 * Web fetch request parameters.
 */
export interface WebFetchUrlRequest {
  /**
   * URL to fetch.
   */
  readonly url: string;

  /**
   * Optional extraction prompt.
   */
  readonly prompt?: string;

  /**
   * Maximum content length in characters.
   */
  readonly maxChars?: number;

  /**
   * Content flavor for HTML sources: light text (default), full markdown, or
   * sanitized markup for DOM inspection.
   */
  readonly format?: "text" | "markdown" | "html";

  /**
   * Content scope for HTML sources: main content region only, or the full
   * page (default).
   */
  readonly content?: "main" | "full";

  /**
   * Whether to append the page link inventory.
   */
  readonly includeLinks?: boolean;

  /**
   * Whether to append the extended metadata block.
   */
  readonly includeMetadata?: boolean;

  /**
   * Optional anchor selector restricting the projection to one section.
   */
  readonly anchor?: string;
}

/**
 * Web fetch cursor pagination parameters.
 */
export interface WebFetchCursorRequest {
  /**
   * Cursor identifier returned by a previous fetch.
   */
  readonly cursor: string;

  /**
   * Offset in characters.
   */
  readonly offsetChars?: number;

  /**
   * Limit in characters.
   */
  readonly limitChars?: number;

  /**
   * Optional maximum content length in characters.
   *
   * @remarks
   * When reading a cursor slice, EnriProxy may treat `maxChars` as a fallback
   * limit if `limitChars` is not provided.
   */
  readonly maxChars?: number;
}

/**
 * Web fetch request union.
 */
export type WebFetchRequest = WebFetchUrlRequest | WebFetchCursorRequest;

/**
 * Web fetch response.
 */
export interface WebFetchResponse {
  /**
   * Fetched content.
   */
  readonly content: string;

  /**
   * HTTP status code.
   */
  readonly status: number;

  /**
   * Content type from the response.
   */
  readonly content_type: string;

  /**
   * Whether content was truncated.
   */
  readonly truncated: boolean;

  /**
   * URL that was fetched (when available).
   */
  readonly url?: string;

  /**
   * Opaque cursor identifier for pagination (when content is truncated/reduced).
   */
  readonly cursor?: string;

  /**
   * Offset in characters (cursor reads).
   */
  readonly offset_chars?: number;

  /**
   * Limit in characters (cursor reads).
   */
  readonly limit_chars?: number;

  /**
   * Total captured characters available for this cursor.
   */
  readonly total_chars?: number;

  /**
   * Whether more content exists beyond this slice.
   */
  readonly has_more?: boolean;

  /**
   * Whether the response content was reduced (excerpt pack).
   */
  readonly reduced?: boolean;

  /**
   * Whether the upstream fetch was truncated (download/capture limits).
   */
  readonly fetched_truncated?: boolean;
}

/**
 * Error thrown when EnriProxy returns a non-2xx HTTP response.
 */
export class EnriProxyHttpError extends Error {
  /**
   * HTTP status code returned by the server.
   */
  public readonly status: number;

  /**
   * Response headers returned by the server.
   */
  public readonly headers: Record<string, string | string[] | undefined>;

  /**
   * Response body returned by the server (best-effort UTF-8).
   */
  public readonly body: string;

  /**
   * Creates a new {@link EnriProxyHttpError}.
   *
   * @param message - Error message
   * @param status - HTTP status code
   * @param headers - Response headers
   * @param body - Response body
   */
  public constructor(
    message: string,
    status: number,
    headers: Record<string, string | string[] | undefined>,
    body: string
  ) {
    super(message);
    this.name = "EnriProxyHttpError";
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/**
 * Result of a simple HTTP request.
 */
interface HttpResult {
  /**
   * HTTP status code.
   */
  readonly status: number;

  /**
   * Response headers.
   */
  readonly headers: Record<string, string | string[] | undefined>;

  /**
   * Response body as string.
   */
  readonly body: string;
}

/**
 * Minimal client for EnriProxy web tool endpoints.
 */
export class EnriProxyClient {
  /**
   * EnriProxy base URL.
   */
  private readonly baseUrl: string;

  /**
   * API key for Authorization header.
   */
  private readonly apiKey: string;

  /**
   * Default timeout for requests.
   */
  private readonly timeoutMs: number;

  /**
   * Creates a new {@link EnriProxyClient}.
   *
   * @param config - Client configuration
   */
  public constructor(config: EnriProxyClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs;
  }

  /**
   * Executes a web search via EnriProxy.
   *
   * @param params - Search parameters
   * @returns Search response
   */
  public async webSearch(params: WebSearchRequest): Promise<WebSearchResponse> {
    const url = this.buildUrl("/v1/tools/web_search");
    const payload: Record<string, unknown> = {
      query: params.query
    };

    if (Array.isArray(params.queries) && params.queries.length > 0) {
      payload["queries"] = params.queries;
    }

    if (typeof params.maxResults === "number") {
      payload["max_results"] = params.maxResults;
    }
    if (typeof params.recency === "string" && params.recency.trim()) {
      payload["recency"] = params.recency.trim();
    }
    if (Array.isArray(params.allowedDomains) && params.allowedDomains.length > 0) {
      payload["allowed_domains"] = params.allowedDomains;
    }
    if (Array.isArray(params.blockedDomains) && params.blockedDomains.length > 0) {
      payload["blocked_domains"] = params.blockedDomains;
    }
    if (typeof params.searchPrompt === "string" && params.searchPrompt.trim()) {
      payload["search_prompt"] = params.searchPrompt.trim();
    }

    const result = await this.requestJson("POST", url, payload, this.timeoutMs);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `La búsqueda web falló (HTTP ${result.status}).`,
        result.status,
        result.headers,
        result.body
      );
    }

    return JSON.parse(result.body) as WebSearchResponse;
  }

  /**
   * Executes a web fetch via EnriProxy.
   *
   * @param params - Fetch parameters
   * @returns Fetch response
   */
  public async webFetch(params: WebFetchRequest): Promise<WebFetchResponse> {
    const url = this.buildUrl("/v1/tools/web_fetch");
    const payload: Record<string, unknown> = {};

    if ("cursor" in params) {
      const cursor = params.cursor.trim();
      if (!cursor) {
        throw new Error("webFetch requiere un cursor no vacío.");
      }
      payload["cursor"] = cursor;

      if (typeof params.offsetChars === "number" && Number.isFinite(params.offsetChars)) {
        payload["offset_chars"] = Math.max(0, Math.trunc(params.offsetChars));
      }
      if (typeof params.limitChars === "number" && Number.isFinite(params.limitChars)) {
        payload["limit_chars"] = Math.max(1, Math.trunc(params.limitChars));
      }
      if (typeof params.maxChars === "number" && Number.isFinite(params.maxChars)) {
        payload["max_chars"] = Math.max(1, Math.trunc(params.maxChars));
      }
    } else {
      payload["url"] = params.url;

      if (typeof params.prompt === "string" && params.prompt.trim()) {
        payload["prompt"] = params.prompt.trim();
      }
      if (typeof params.maxChars === "number") {
        payload["max_chars"] = params.maxChars;
      }
      if (params.format === "markdown" || params.format === "text" || params.format === "html") {
        payload["format"] = params.format;
      }
      if (params.content === "main" || params.content === "full") {
        payload["content"] = params.content;
      }
      if (params.includeLinks === true) {
        payload["include_links"] = true;
      }
      if (params.includeMetadata === true) {
        payload["include_metadata"] = true;
      }
      if (typeof params.anchor === "string" && params.anchor.trim()) {
        payload["anchor"] = params.anchor.trim().replace(/^#+/, "").slice(0, 300);
      }
    }

    const result = await this.requestJson("POST", url, payload, this.timeoutMs);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `El fetch web falló (HTTP ${result.status}).`,
        result.status,
        result.headers,
        result.body
      );
    }

    return JSON.parse(result.body) as WebFetchResponse;
  }

  /**
   * Builds an absolute URL relative to the configured base URL.
   *
   * @param pathname - Pathname to append
   * @returns URL instance
   */
  private buildUrl(pathname: string): URL {
    return new URL(pathname, this.baseUrl);
  }

  /**
   * Sends a JSON request and returns the response.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @param jsonBody - JSON payload
   * @param timeoutMs - Timeout in milliseconds
   * @returns HTTP result
   */
  private async requestJson(
    method: "POST",
    url: URL,
    jsonBody: Record<string, unknown>,
    timeoutMs: number
  ): Promise<HttpResult> {
    const body = JSON.stringify(jsonBody);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body))
    };
    return this.requestRaw(method, url, headers, Buffer.from(body, "utf8"), timeoutMs);
  }

  /**
   * Sends an HTTP request with optional headers and body.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @param headers - Request headers
   * @param body - Request body
   * @param timeoutMs - Timeout in milliseconds
   * @returns HTTP result
   */
  private async requestRaw(
    method: "POST",
    url: URL,
    headers: Record<string, string> | undefined,
    body: Buffer | undefined,
    timeoutMs: number
  ): Promise<HttpResult> {
    const isHttps = url.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(headers ?? {})
    };

    return await new Promise<HttpResult>((resolve, reject) => {
      const req = reqFn(
        url,
        {
          method,
          headers: requestHeaders
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          const maxResponseBytes = 20 * 1024 * 1024;

          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxResponseBytes) {
              req.destroy(new Error("La respuesta excedió el tamaño máximo permitido."));
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
        }
      );

      req.on("error", (error) => reject(error));
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`La petición expiró después de ${timeoutMs}ms`));
      });

      if (body && body.length > 0) {
        req.write(body);
      }
      req.end();
    });
  }
}
