/**
 * ENRIPROXY CLIENT
 *
 * Minimal HTTP client for EnriProxy web tool endpoints:
 * - POST /v1/tools/web_search
 * - POST /v1/tools/web_fetch
 *
 * @module client/EnriProxyClient
 *
 * @remarks Size note (~950 lines, documented exception to the <=700 policy):
 * one file currently owns the transport (dual-timeout raw HTTP, abort
 * labeling, response-size ceilings), the wire payload builders, the typed
 * response contracts, and the Spanish error mapping. The planned split is a
 * dedicated `EnriProxyHttpTransport` module; until that batch, moving any
 * single piece would duplicate the carefully paired timeout/abort/cap
 * invariants that the tests pin together.
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";
import { sliceUtf8Safe } from "../shared/Utf8SafeTextSlicer.js";

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

  /**
   * Optional SearXNG engine selector overriding the proxy default.
   */
  readonly engines?: string;
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
 * One verified page content attached to a web search response.
 */
export interface WebSearchFetchedContentEntry {
  /**
   * URL that was fetched.
   */
  readonly url: string;

  /**
   * Result title at fetch time.
   */
  readonly title: string;

  /**
   * Extracted page content (truncated to the server budget).
   */
  readonly content: string;

  /**
   * Whether the content was truncated to the server budget.
   */
  readonly truncated: boolean;
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

  /**
   * SearXNG engines that did not respond, when the server reported any.
   */
  readonly unresponsive_engines?: string[];

  /**
   * Whether the server clamped the caller's `search_prompt` to its cap.
   */
  readonly search_prompt_truncated?: boolean;

  /**
   * Spanish notice describing the clamped `search_prompt`, when clamped.
   */
  readonly search_prompt_notice?: string;

  /**
   * Verified page contents for the top results, when server-side
   * auto-fetch is enabled.
   */
  readonly fetched_contents?: WebSearchFetchedContentEntry[];

  /**
   * Number of verified page contents attached to the response.
   */
  readonly fetched_count?: number;

  /**
   * Spanish note explaining the auto-fetch outcome (e.g. why
   * `fetched_contents` is empty or partial), when the server reported one.
   */
  readonly fetch_note?: string;

  /**
   * Per-query URL groups, when the request used batched queries.
   */
  readonly per_query?: Array<{ query: string; urls: string[] }>;
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
   * Content scope for HTML sources: main content region only (default), or
   * the full page.
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

  /**
   * Optional screenshot request for vision-capable clients: "auto" captures
   * only when the extracted text is too thin to describe the page, "force"
   * captures regardless, "none" never captures.
   */
  readonly screenshot?: "auto" | "force" | "none";
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
 * Options refining transport behavior for one request.
 *
 * @remarks
 * `callerSignal` lets a caller that wraps a combined subfetch signal (caller
 * abort + `AbortSignal.timeout`) tell the client which aborts are genuine
 * client cancellations and which are subfetch timeouts.
 */
export interface EnriProxyRequestOptions {
  /**
   * True caller abort signal backing the combined `signal` argument.
   */
  readonly callerSignal?: AbortSignal;

  /**
   * Timeout budget (ms) behind a combined subfetch signal, used to label
   * timeout aborts that the caller did not trigger.
   */
  readonly subfetchTimeoutMs?: number;

  /**
   * Explicit response byte ceiling for this request.
   *
   * @remarks
   * Callers that know the expected payload size (for example one slice of
   * a grouped-ranges fan-out) bound the buffered response to that slice
   * instead of the default full-budget ceiling; omitted falls back to the
   * max_chars-derived default.
   */
  readonly maxResponseBytes?: number;
}

/**
 * Web fetch request to release a cursor's server-side capture.
 */
export interface WebFetchDeleteRequest {
  /**
   * Cursor identifier returned by a previous fetch.
   */
  readonly cursor: string;

  /**
   * Literal action marker selecting cursor deletion.
   */
  readonly action: "delete";
}

/**
 * Web fetch delete-cursor response.
 */
export interface WebFetchDeleteResponse {
  /**
   * Whether the cursor existed and was deleted.
   */
  readonly deleted: boolean;

  /**
   * Cursor the deletion addressed.
   */
  readonly cursor: string;
}

/**
 * Web fetch request union.
 */
export type WebFetchRequest = WebFetchUrlRequest | WebFetchCursorRequest;

/**
 * Default ceiling for one proxied response body.
 *
 * @remarks
 * Generous for the default 200k-char budget; larger `max_chars` budgets
 * derive a higher ceiling via {@link resolveMaxResponseBytes}.
 */
const DEFAULT_MAX_RESPONSE_BYTES: number = 20 * 1024 * 1024;

/**
 * Derives the per-request response size ceiling from the content budget.
 *
 * @remarks
 * EnriProxy answers JSON, so every character may expand up to ~6 bytes
 * (`\uXXXX` escapes, quotes, newlines). A known `maxChars` raises the
 * ceiling to `6 × maxChars + 1MB` so a legitimate ~4M-char capture rich in
 * escapes is not rejected mid-stream.
 *
 * @param maxChars - Requested content budget in characters, when known.
 * @returns Maximum accepted response body in bytes.
 */
export function resolveMaxResponseBytes(maxChars: number | undefined): number {
  if (maxChars === undefined) {
    return DEFAULT_MAX_RESPONSE_BYTES;
  }
  return Math.max(DEFAULT_MAX_RESPONSE_BYTES, 6 * maxChars + 1024 * 1024);
}

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
   * Exact offset where the next page starts (cursor reads), when the proxy
   * reports it.
   */
  readonly next_offset_chars?: number;

  /**
   * Zero-based offset inside `content` where the undecorated page starts
   * (URL reads with a status-line decoration).
   */
  readonly page_offset_chars?: number;

  /**
   * Length of the undecorated page inside `content` (URL reads).
   */
  readonly page_chars?: number;

  /**
   * Whether the response content was reduced (excerpt pack).
   */
  readonly reduced?: boolean;

  /**
   * Whether the upstream fetch was truncated (download/capture limits).
   */
  readonly fetched_truncated?: boolean;

  /**
   * Captured page screenshots in scroll order, when a screenshot request
   * passed the proxy's capture policy.
   */
  readonly screenshots?: WebFetchResponseScreenshot[];

  /**
   * Whether the proxy captured ("captured") or skipped ("skipped")
   * screenshots for this call.
   */
  readonly screenshot_status?: "captured" | "skipped";

  /**
   * Why screenshots were captured or skipped (e.g. "auto_thin_text",
   * "forced", "auto_rich_text", "background_verification",
   * "http_error_status", "capture_failed", "lane_unsupported").
   */
  readonly screenshot_reason?: string;
}

/**
 * One captured page screenshot segment in a web fetch response.
 */
export interface WebFetchResponseScreenshot {
  /**
   * Image MIME type (always `image/jpeg`).
   */
  readonly mime_type: string;

  /**
   * Base64-encoded image bytes.
   */
  readonly base64: string;

  /**
   * Image width in pixels.
   */
  readonly width: number;

  /**
   * Image height in pixels.
   */
  readonly height: number;

  /**
   * Window scrollY (pixels) at capture time.
   */
  readonly scroll_y: number;
}

/**
 * Transport-level options forwarded to {@link EnriProxyClient.requestRaw}.
 */
interface RequestTransportOptions extends EnriProxyRequestOptions {
  /**
   * Derived response size ceiling for this request.
   */
  readonly maxResponseBytes?: number;
}

/**
 * Upper character budget accepted from one tool call.
 *
 * @remarks
 * Single source of truth for the shared 4M wire ceiling: the client clamps
 * every request payload with it and the tool layer imports the same constant
 * so the documented ceiling cannot drift between modules.
 */
export const MAX_WIRE_MAX_CHARS = 4_000_000;

/**
 * Detects a delete-cursor web fetch request.
 *
 * @param params - Web fetch request union member
 * @returns True when the request deletes a cursor.
 */
function isDeleteRequest(
  params: WebFetchDeleteRequest | WebFetchRequest
): params is WebFetchDeleteRequest {
  return "action" in params && params.action === "delete";
}

/**
 * Normalizes one max_chars budget to a positive integer within the ceiling.
 *
 * @param value - Raw budget value.
 * @returns Normalized budget, or undefined when unusable.
 */
function normalizeMaxChars(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.min(MAX_WIRE_MAX_CHARS, Math.max(1, Math.trunc(value)));
}

/**
 * Matches proxy diagnostics reporting a missing or expired web_fetch cursor
 * (Spanish canonical message plus the legacy English wording).
 */
const EXPIRED_CURSOR_DIAGNOSTIC_PATTERN = /cursor (no encontrado|not found|expirado|expired)/i;

/**
 * Reports whether free text carries an expired/missing cursor diagnostic.
 *
 * @param text - Candidate message or response body.
 * @returns True when the text reports a dead cursor.
 */
export function isExpiredCursorMessageText(text: string): boolean {
  return EXPIRED_CURSOR_DIAGNOSTIC_PATTERN.test(text);
}

/**
 * Reports whether a failure is an expired/missing web_fetch cursor.
 *
 * @remarks
 * Only HTTP 400 proxy rejections carrying the cursor diagnostic qualify: a
 * missing diagnostic (or any other status) is a different failure and must
 * keep its original error path instead of triggering cursor recovery.
 *
 * @param error - Failure thrown by {@link EnriProxyClient.webFetch}.
 * @returns True for expired-cursor rejections.
 */
export function isExpiredCursorError(error: unknown): boolean {
  if (!(error instanceof EnriProxyHttpError) || error.status !== 400) {
    return false;
  }
  return isExpiredCursorMessageText(`${error.message} ${error.body}`);
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
   * @param signal - Optional caller abort signal
   * @returns Search response
   */
  public async webSearch(
    params: WebSearchRequest,
    signal?: AbortSignal,
    options?: EnriProxyRequestOptions
  ): Promise<WebSearchResponse> {
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
    if (typeof params.engines === "string" && params.engines.trim()) {
      payload["engines"] = params.engines.trim();
    }

    const result = await this.requestJson("POST", url, payload, this.timeoutMs, signal, options);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `La búsqueda web falló (HTTP ${result.status}). ${EnriProxyClient.describeHttpStatus(result.status)}`.trimEnd(),
        result.status,
        result.headers,
        result.body.slice(0, 4000)
      );
    }

    try {
      return JSON.parse(result.body) as WebSearchResponse;
    } catch (error) {
      throw new Error(
        `Respuesta no JSON de EnriProxy en /v1/tools/web_search (HTTP ${String(result.status)}): ${EnriProxyClient.describeUnparseableBody(error)}`
      );
    }
  }

  /**
   * Executes a web fetch via EnriProxy.
   *
   * @param params - Fetch parameters (URL read, cursor read, or cursor delete)
   * @param signal - Optional caller abort signal
   * @param options - Optional transport options (subfetch abort labeling)
   * @returns Fetch response
   */
  public async webFetch(
    params: WebFetchDeleteRequest,
    signal?: AbortSignal,
    options?: EnriProxyRequestOptions
  ): Promise<WebFetchDeleteResponse>;
  public async webFetch(
    params: WebFetchRequest,
    signal?: AbortSignal,
    options?: EnriProxyRequestOptions
  ): Promise<WebFetchResponse>;
  public async webFetch(
    params: WebFetchDeleteRequest | WebFetchRequest,
    signal?: AbortSignal,
    options?: EnriProxyRequestOptions
  ): Promise<WebFetchDeleteResponse | WebFetchResponse> {
    const url = this.buildUrl("/v1/tools/web_fetch");
    const payload: Record<string, unknown> = {};

    if (isDeleteRequest(params)) {
      const cursor = params.cursor.trim();
      if (!cursor) {
        throw new Error("webFetch requiere un cursor no vacío.");
      }
      payload["cursor"] = cursor;
      payload["action"] = "delete";
    } else if ("cursor" in params) {
      const cursor = params.cursor.trim();
      if (!cursor) {
        throw new Error("webFetch requiere un cursor no vacío.");
      }
      payload["cursor"] = cursor;

      if (typeof params.offsetChars === "number" && Number.isFinite(params.offsetChars)) {
        payload["offset_chars"] = Math.max(0, Math.trunc(params.offsetChars));
      }
      if (typeof params.limitChars === "number" && Number.isFinite(params.limitChars)) {
        const limitChars: number = Math.trunc(params.limitChars);
        // A zero limit means "no explicit limit" (tool contract); only send
        // positive limits so direct callers agree with the tool layer.
        if (limitChars !== 0) {
          payload["limit_chars"] = Math.max(1, limitChars);
        }
      }
      const cursorMaxChars: number | undefined = normalizeMaxChars(params.maxChars);
      if (cursorMaxChars !== undefined) {
        payload["max_chars"] = cursorMaxChars;
      }
    } else {
      payload["url"] = params.url;

      if (typeof params.prompt === "string" && params.prompt.trim()) {
        payload["prompt"] = params.prompt.trim();
      }
      const urlMaxChars: number | undefined = normalizeMaxChars(params.maxChars);
      if (urlMaxChars !== undefined) {
        payload["max_chars"] = urlMaxChars;
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
      if (params.includeLinks === false) {
        payload["include_links"] = false;
      }
      if (params.includeMetadata === true) {
        payload["include_metadata"] = true;
      }
      if (params.includeMetadata === false) {
        payload["include_metadata"] = false;
      }
      if (typeof params.anchor === "string" && params.anchor.trim()) {
        const anchor: string = sliceUtf8Safe(params.anchor.trim().replace(/^#+/, "").trim(), 0, 300);
        if (anchor) {
          payload["anchor"] = anchor;
        }
      }
      if (params.screenshot === "auto" || params.screenshot === "force" || params.screenshot === "none") {
        payload["screenshot"] = params.screenshot;
      }
    }

    const requestMaxChars: number | undefined = isDeleteRequest(params)
      ? undefined
      : normalizeMaxChars(params.maxChars);
    const transportOptions: RequestTransportOptions = {
      ...options,
      maxResponseBytes: options?.maxResponseBytes ?? resolveMaxResponseBytes(requestMaxChars)
    };

    const result = await this.requestJson("POST", url, payload, this.timeoutMs, signal, transportOptions);
    if (result.status < 200 || result.status >= 300) {
      throw new EnriProxyHttpError(
        `El fetch web falló (HTTP ${result.status}). ${EnriProxyClient.describeHttpStatus(result.status)}`.trimEnd(),
        result.status,
        result.headers,
        result.body.slice(0, 4000)
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.body);
    } catch (error) {
      throw new Error(
        `Respuesta no JSON de EnriProxy en /v1/tools/web_fetch (HTTP ${String(result.status)}): ${EnriProxyClient.describeUnparseableBody(error)}`
      );
    }

    if (isDeleteRequest(params)) {
      const record: Record<string, unknown> =
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      return {
        deleted: record["deleted"] === true,
        cursor: typeof record["cursor"] === "string" ? record["cursor"] : params.cursor
      } satisfies WebFetchDeleteResponse;
    }
    return parsed as WebFetchResponse;
  }

  /**
   * Summarizes a response-body parse failure as a bounded Spanish tail.
   *
   * @remarks
   * V8's parser message ("Unexpected token …") is English jargon that would
   * reach the model verbatim through the tool result; it is reduced to a
   * Spanish label plus at most 80 characters of raw parser detail.
   *
   * @param error - Failure thrown while parsing the proxy response body.
   * @returns Short Spanish summary for a model-facing error message.
   */
  private static describeUnparseableBody(error: unknown): string {
    const raw: string = error instanceof Error ? error.message : String(error);
    return `cuerpo de respuesta no parseable (${sliceUtf8Safe(raw, 0, 80)})`;
  }

  /**
   * Summarizes one non-2xx HTTP status as bounded Spanish guidance.
   *
   * @remarks
   * The raw HTTP client does not follow redirects: an `ENRIPROXY_URL` behind
   * a 301/302/303/307/308 would otherwise surface as a bare status code with
   * no hint that the server configuration (not the call) must change.
   *
   * @param status - HTTP status returned by the server.
   * @returns Spanish guidance suffix (may be empty).
   */
  private static describeHttpStatus(status: number): string {
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) {
      return "El servidor respondió con una redirección que este cliente no sigue: configure ENRIPROXY_URL con la URL final (sin redirección) y reintente.";
    }
    return "";
  }

  /**
   * Builds an absolute URL relative to the configured base URL.
   *
   * @param pathname - Pathname to append
   * @returns URL instance
   */
  private buildUrl(pathname: string): URL {
    const base: URL = new URL(this.baseUrl);
    const basePath: string = base.pathname.replace(/\/+$/u, "");
    const cleanPath: string = pathname.startsWith("/") ? pathname : `/${pathname}`;
    base.pathname = `${basePath}${cleanPath}`.replace(/\/{2,}/gu, "/");
    base.search = "";
    base.hash = "";
    return base;
  }

  /**
   * Sends a JSON request and returns the response.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @param jsonBody - JSON payload
   * @param timeoutMs - Timeout in milliseconds
   * @param signal - Optional caller abort signal
   * @returns HTTP result
   */
  private async requestJson(
    method: "POST",
    url: URL,
    jsonBody: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
    options?: RequestTransportOptions
  ): Promise<HttpResult> {
    const body = JSON.stringify(jsonBody);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body))
    };
    return this.requestRaw(method, url, headers, Buffer.from(body, "utf8"), timeoutMs, signal, options);
  }

  /**
   * Sends an HTTP request with optional headers and body.
   *
   * @param method - HTTP method
   * @param url - Target URL
   * @param headers - Request headers
   * @param body - Request body
   * @param timeoutMs - Timeout in milliseconds
   * @param signal - Optional abort signal (destroys the request on abort)
   * @param options - Optional transport options (caller signal labeling, size ceiling)
   * @returns HTTP result
   */
  private async requestRaw(
    method: "POST",
    url: URL,
    headers: Record<string, string> | undefined,
    body: Buffer | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    options?: RequestTransportOptions
  ): Promise<HttpResult> {
    const isHttps = url.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;

    const requestHeaders: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      ...(headers ?? {})
    };

    // When the caller wraps its signal (caller abort + subfetch timeout) it
    // also passes `callerSignal`: an abort with a live caller signal means
    // the subfetch timeout fired, not a client cancellation.
    const callerSignal: AbortSignal | undefined = options?.callerSignal;
    const abortMessage = (): string => {
      if (callerSignal !== undefined && !callerSignal.aborted) {
        return `La petición expiró después de ${String(options?.subfetchTimeoutMs ?? timeoutMs)}ms`;
      }
      return "La petición fue cancelada por el cliente.";
    };

    return await new Promise<HttpResult>((resolve, reject) => {
      let settled = false;
      const settleResolve = (result: HttpResult): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };
      const settleReject = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      if (signal?.aborted) {
        settleReject(new Error(abortMessage()));
        return;
      }
      const req = reqFn(
        url,
        {
          method,
          headers: requestHeaders
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          const maxResponseBytes: number = options?.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxResponseBytes) {
              cleanupAbort();
              settleReject(new Error("La respuesta excedió el tamaño máximo permitido."));
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });

          res.on("error", (error: Error) => {
            cleanupAbort();
            req.destroy();
            settleReject(error);
          });

          res.on("end", () => {
            cleanupAbort();
            settleResolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string | string[] | undefined>,
              body: Buffer.concat(chunks).toString("utf8")
            });
          });
        }
      );

      const cleanupAbort = (): void => {
        try {
          req.setTimeout(0);
        } catch {
          // Best-effort timer disarm on finished sockets.
        }
        if (totalBudgetTimer !== undefined) {
          clearTimeout(totalBudgetTimer);
        }
        if (signal !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
      };
      const onAbort = (): void => {
        req.destroy(new Error(abortMessage()));
      };
      const onError = (error: Error): void => {
        cleanupAbort();
        settleReject(error);
      };
      const onTimeout = (): void => {
        cleanupAbort();
        req.destroy(new Error(`La petición expiró después de ${timeoutMs}ms`));
      };
      if (signal !== undefined) {
        signal.addEventListener("abort", onAbort, { once: true });
      }

      req.on("error", onError);
      // Socket-inactivity timeout (per-chunk deadline): a slow-drip response
      // could otherwise extend the documented budget indefinitely.
      req.setTimeout(timeoutMs, onTimeout);
      // Total-budget timer: bounds the whole request wall-clock time so the
      // documented ENRIWEB_TIMEOUT_MS / ENRIWEB_SEARCH_TIMEOUT_MS budgets
      // hold even when chunks keep arriving (matching EnriCode's
      // AbortSignal.timeout semantics).
      const totalBudgetTimer: ReturnType<typeof setTimeout> | undefined = setTimeout((): void => {
        req.destroy(new Error(`La petición expiró después de ${timeoutMs}ms (presupuesto total)`));
      }, timeoutMs);
      totalBudgetTimer.unref?.();

      if (body && body.length > 0) {
        req.write(body);
      }
      req.end();
    });
  }
}
