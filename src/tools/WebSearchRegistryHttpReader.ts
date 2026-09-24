/**
 * Capped JSON HTTP reader for package registry endpoints.
 *
 * @remarks
 * Extracted from {@link WebSearchRegistryVerifier} (size policy AR-9: any
 * touch must extract the touched unit): owns the transport concerns of
 * registry verification — timeout classification, byte caps on declared and
 * streamed bodies, JSON parsing, and Link-header pagination — with Spanish
 * error surfaces. The verifier keeps registry semantics only.
 *
 * @module tools/WebSearchRegistryHttpReader
 */

/**
 * Options for one registry JSON fetch.
 */
export interface RegistryFetchOptions {
  /**
   * Accept header value sent to the registry.
   */
  readonly accept: string;

  /**
   * Optional per-request byte cap overriding
   * {@link WebSearchRegistryHttpReader.MAX_JSON_BYTES}.
   *
   * @remarks
   * Used by the npm verifier: popular packuments (thousands of versions of
   * full metadata) legitimately exceed the default cap, and the EnriCode
   * client plane reads the same endpoint with 16 MiB.
   */
  readonly maxBytes?: number;

  /**
   * Optional GitHub token for authenticated registry reads.
   */
  readonly githubToken?: string;

  /**
   * Optional caller cancellation signal.
   */
  readonly signal?: AbortSignal;
}

/**
 * Dependencies for {@link WebSearchRegistryHttpReader}.
 */
export interface WebSearchRegistryHttpReaderDeps {
  /**
   * Fetch implementation used for registry requests.
   */
  readonly fetchImpl: typeof fetch;

  /**
   * Per-request timeout budget in milliseconds.
   */
  readonly timeoutMs: number;
}

/**
 * Result of one registry JSON fetch.
 */
export interface RegistryFetchResult {
  /**
   * Parsed JSON payload.
   */
  readonly value: unknown;

  /**
   * `rel="next"` target from the Link header, when the endpoint pages.
   */
  readonly nextUrl: string | null;
}

/**
 * Performs capped, timeout-guarded JSON reads against registry APIs.
 */
export class WebSearchRegistryHttpReader {
  /**
   * Maximum JSON payload accepted from a registry endpoint.
   */
  public static readonly MAX_JSON_BYTES: number = 5_000_000;

  /**
   * Reader dependencies.
   */
  private readonly deps: WebSearchRegistryHttpReaderDeps;

  /**
   * Creates one registry HTTP reader.
   *
   * @param deps - Fetch implementation and timeout budget.
   */
  public constructor(deps: WebSearchRegistryHttpReaderDeps) {
    this.deps = deps;
  }

  /**
   * Performs an HTTP GET expecting a JSON response.
   *
   * @param url - Target URL
   * @param options - Request options
   * @returns Parsed JSON plus the `rel="next"` Link target, when present
   */
  public async fetchJson(url: string, options: RegistryFetchOptions): Promise<RegistryFetchResult> {
    const controller = new AbortController();
    let timedOut: boolean = false;
    const timeout = setTimeout((): void => {
      timedOut = true;
      controller.abort();
    }, this.deps.timeoutMs);
    const combined: AbortSignal =
      options.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, options.signal]);

    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": "enriweb"
    };
    // The GitHub token is only useful for (and only ever sent to) GitHub API
    // hosts: pagination follows `rel="next"` Link targets that come from the
    // RESPONDER, so an unguarded header would let a compromised or malicious
    // registry exfiltrate the token by pointing pagination elsewhere.
    if (options.githubToken && options.githubToken.trim() && WebSearchRegistryHttpReader.isGithubApiUrl(url)) {
      headers["Authorization"] = `Bearer ${options.githubToken.trim()}`;
    }

    try {
      const response = await this.deps.fetchImpl(url, {
        method: "GET",
        headers,
        signal: combined
      });
      if (!response.ok) {
        throw new Error(`HTTP ${String(response.status)} para ${url}`);
      }
      const declaredLengthRaw: string | null = response.headers.get("content-length");
      const declaredLength: number =
        declaredLengthRaw !== null ? Number.parseInt(declaredLengthRaw, 10) : NaN;
      const maxBytes: number = options.maxBytes ?? WebSearchRegistryHttpReader.MAX_JSON_BYTES;
      if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw new Error(
          `La respuesta JSON de ${url} excede el máximo de ${String(maxBytes)} bytes.`
        );
      }
      const text: string = await WebSearchRegistryHttpReader.readBodyCapped(
        response,
        maxBytes,
        url
      );
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        throw new Error(
          `La respuesta JSON de ${url} excede el máximo de ${String(maxBytes)} bytes.`
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Respuesta no JSON del registro en ${url}.`);
      }
      return {
        value: parsed,
        nextUrl: WebSearchRegistryHttpReader.parseNextLinkHeader(response.headers.get("link"))
      };
    } catch (error: unknown) {
      // The internal timeout abort is indistinguishable from a caller
      // cancellation at the signal level; the flag reclassifies it as a
      // TimeoutError so the cached error entity says "tiempo de espera"
      // instead of the misleading "operación cancelada".
      if (timedOut && options.signal?.aborted !== true) {
        throw new DOMException("Timeout", "TimeoutError");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Reports whether one URL points at a GitHub API host.
   *
   * @remarks
   * Guards the `Authorization` header: only `api.github.com` and other
   * `*.github.com` API hosts ever receive the configured GitHub token, so
   * Link-header pagination can never carry the credential to a third party.
   *
   * @param url - Candidate request URL.
   * @returns True for GitHub API hosts.
   */
  private static isGithubApiUrl(url: string): boolean {
    try {
      const parsed: URL = new URL(url);
      if (parsed.protocol !== "https:") {
        return false;
      }
      const host: string = parsed.hostname.toLowerCase();
      return host === "api.github.com" || host.endsWith(".github.com");
    } catch {
      return false;
    }
  }

  /**
   * Reads one response body as text without buffering past the byte cap.
   *
   * @remarks
   * A missing content-length (chunked responses) previously downloaded the
   * whole body into memory before the size check; the capped stream aborts
   * mid-flight instead, so a misbehaving registry endpoint cannot balloon
   * the verifier's footprint.
   *
   * @param response - Fetch response whose body is being read.
   * @param maxBytes - Hard byte cap for this body.
   * @param url - Source URL used in the Spanish error message.
   * @returns Decoded UTF-8 body text within the cap.
   * @throws Error (Spanish) when the body exceeds the cap before ending.
   */
  private static async readBodyCapped(
    response: Response,
    maxBytes: number,
    url: string
  ): Promise<string> {
    const bodyStream = response.body;
    if (bodyStream === null || bodyStream === undefined) {
      return await response.text();
    }
    const reader = bodyStream.getReader();
    const chunks: Uint8Array[] = [];
    let received: number = 0;
    for (;;) {
      const outcome = await reader.read();
      if (outcome.done) {
        break;
      }
      received += outcome.value.byteLength;
      if (received > maxBytes) {
        await reader.cancel("registry-json-too-large").catch((): void => undefined);
        throw new Error(
          `La respuesta JSON de ${url} excede el máximo de ${String(maxBytes)} bytes.`
        );
      }
      chunks.push(outcome.value);
    }
    const total: Uint8Array = new Uint8Array(received);
    let offset: number = 0;
    for (const chunk of chunks) {
      total.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8").decode(total);
  }

  /**
   * Extracts the `rel="next"` target from a Link header.
   *
   * @param headerValue - Raw Link header, when present.
   * @returns Next page URL, or null when the response has no next page.
   */
  private static parseNextLinkHeader(headerValue: string | null): string | null {
    if (headerValue === null || !headerValue.trim()) {
      return null;
    }
    const match: RegExpMatchArray | null = /<([^>]+)>;\s*rel="next"/u.exec(headerValue);
    return match?.[1] ?? null;
  }
}
