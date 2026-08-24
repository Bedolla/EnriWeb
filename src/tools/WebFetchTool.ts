/**
 * WEB FETCH TOOL
 *
 * Implements the `web_fetch` MCP tool by delegating to EnriProxy.
 *
 * @module tools/WebFetchTool
 */
import type { EnriProxyClient } from "../client/EnriProxyClient.js";
import {
  assertHttpUrl,
  assertNonEmptyString,
  assertObject,
  optionalInt,
  optionalString
} from "../shared/validation.js";

/**
 * Default number of characters to include in the human-readable MCP output.
 *
 * @remarks
 * The full fetched payload is still available in `structuredContent.content`,
 * but MCP clients may enforce tool-result token limits. Keeping the human
 * output short avoids duplication and reduces the chance of overflows.
 */
const DEFAULT_TEXT_PREVIEW_CHARS = 2000;

/**
 * Tool parameters for `web_fetch`.
 */
export interface WebFetchToolParams {
  /**
   * URL to fetch.
   */
  readonly url?: string;

  /**
   * Cursor identifier returned by a previous call.
   */
  readonly cursor?: string;

  /**
   * Optional prompt for extraction.
   */
  readonly prompt?: string;

  /**
   * Maximum content length in characters.
   */
  readonly maxChars?: number;

  /**
   * Content flavor for HTML sources: light text (default) or full markdown.
   */
  readonly format?: "text" | "markdown";

  /**
   * Offset in characters for cursor pagination.
   */
  readonly offsetChars?: number;

  /**
   * Limit in characters for cursor pagination.
   */
  readonly limitChars?: number;
}

/**
 * Tool result for `web_fetch`.
 */
export interface WebFetchToolResult extends Record<string, unknown> {
  /**
   * Fetched content.
   */
  readonly content: string;

  /**
   * HTTP status code.
   */
  readonly status: number;

  /**
   * Content type of the response.
   */
  readonly content_type: string;

  /**
   * Whether content was truncated.
   */
  readonly truncated: boolean;

  /**
   * URL that was fetched.
   */
  readonly url: string;

  /**
   * Cursor identifier for pagination (when available).
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
   * Total captured characters (cursor reads).
   */
  readonly total_chars?: number;

  /**
   * Whether more content exists beyond this slice.
   */
  readonly has_more?: boolean;

  /**
   * Whether content was reduced into an excerpt pack.
   */
  readonly reduced?: boolean;

  /**
   * Whether the upstream fetch was truncated.
   */
  readonly fetched_truncated?: boolean;
}

/**
 * Dependencies for {@link WebFetchTool}.
 */
export interface WebFetchToolDeps {
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
   * Default maximum content length in characters returned by the tool when
   * `max_chars` is not provided.
   */
  readonly defaultMaxChars: number;
}

/**
 * MCP tool that fetches URL content via EnriProxy.
 */
export class WebFetchTool {
  /**
   * Readme file candidates commonly used in GitHub repositories.
   */
  private static readonly README_FILENAMES: readonly string[] = [
    "README.md",
    "readme.md"
  ];

  /**
   * Default branches to try when resolving GitHub raw README URLs.
   */
  private static readonly README_BRANCHES: readonly string[] = ["main", "master"];

  /**
   * Tool dependencies.
   */
  private readonly deps: WebFetchToolDeps;

  /**
   * Creates a new {@link WebFetchTool}.
   *
   * @param deps - Tool dependencies
   */
  public constructor(deps: WebFetchToolDeps) {
    this.deps = deps;
  }

  /**
   * Gets the configured default max chars for web fetch results.
   *
   * @returns Default max chars
   */
  public getDefaultMaxChars(): number {
    return this.deps.defaultMaxChars;
  }

  /**
   * Validates raw MCP tool arguments.
   *
   * @param raw - Raw tool arguments
   * @returns Validated parameters
   */
  public parseParams(raw: unknown): WebFetchToolParams {
    const obj = assertObject(raw, "arguments");

    const cursorRaw = optionalString(obj["cursor"]);
    const cursor = cursorRaw?.trim() ? cursorRaw.trim() : undefined;

    const urlRaw = optionalString(obj["url"]);
    const url = urlRaw?.trim() ? assertHttpUrl(urlRaw.trim(), "url") : undefined;

    if (!cursor && !url) {
      throw new Error("web_fetch requiere 'url' o 'cursor'.");
    }

    const prompt = optionalString(obj["prompt"]);
    const maxChars = optionalInt(obj["max_chars"]);
    const format: "text" | "markdown" | undefined =
      obj["format"] === "markdown" ? "markdown" : obj["format"] === "text" ? "text" : undefined;
    const offsetCharsRaw = optionalInt(obj["offset_chars"]) ?? optionalInt(obj["offset"]);
    const limitCharsRaw = optionalInt(obj["limit_chars"]) ?? optionalInt(obj["limit"]);

    if (maxChars !== undefined && maxChars < 1) {
      throw new Error("max_chars debe ser positivo.");
    }

    const offsetChars = cursor ? offsetCharsRaw : undefined;
    let limitChars: number | undefined = cursor ? limitCharsRaw : undefined;

    if (offsetChars !== undefined && offsetChars < 0) {
      throw new Error("offset debe ser no negativo.");
    }

    if (limitChars !== undefined) {
      if (limitChars < 0) {
        throw new Error("limit debe ser positivo.");
      }
      if (limitChars === 0) {
        limitChars = undefined;
      }
    }

    return {
      url,
      cursor,
      prompt,
      maxChars,
      format,
      offsetChars,
      limitChars
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
    const effectiveMaxChars =
      typeof params.maxChars === "number" ? params.maxChars : this.deps.defaultMaxChars;

    if (typeof params.cursor === "string" && params.cursor.trim()) {
      const response = await client.webFetch({
        cursor: params.cursor.trim(),
        offsetChars: params.offsetChars,
        limitChars: params.limitChars,
        maxChars: effectiveMaxChars
      });

      const resolvedUrl = response.url ?? params.url ?? "(cursor)";
      return {
        content: response.content,
        status: response.status,
        content_type: response.content_type,
        truncated: response.truncated,
        url: resolvedUrl,
        cursor: response.cursor,
        offset_chars: response.offset_chars,
        limit_chars: response.limit_chars,
        total_chars: response.total_chars,
        has_more: response.has_more,
        reduced: response.reduced,
        fetched_truncated: response.fetched_truncated
      };
    }

    if (!params.url) {
      throw new Error("web_fetch requiere una URL cuando no se proporciona cursor.");
    }

    const url: string = params.url;
    const urlParams: WebFetchToolParams & { readonly url: string } = {
      ...params,
      url
    };

    const npmResult = await this.tryExecuteNpmPackageFetch(
      urlParams,
      client,
      effectiveMaxChars
    );
    if (npmResult) {
      return npmResult;
    }

      const response = await client.webFetch({
        url,
        prompt: params.prompt,
        maxChars: effectiveMaxChars,
        format: params.format
      });

    return {
      content: response.content,
      status: response.status,
      content_type: response.content_type,
      truncated: response.truncated,
      url: response.url ?? url,
      cursor: response.cursor,
      total_chars: response.total_chars,
      has_more: response.has_more,
      reduced: response.reduced,
      fetched_truncated: response.fetched_truncated
    };
  }

  /**
   * Attempts to provide a higher-quality fetch for npm package pages.
   *
   * @param params - Tool parameters
   * @param client - EnriProxy client
   * @param maxChars - Maximum content length to return
   * @returns Tool result if the URL is an npm package page, otherwise null
   */
  private async tryExecuteNpmPackageFetch(
    params: WebFetchToolParams & { readonly url: string },
    client: EnriProxyClient,
    maxChars: number
  ): Promise<WebFetchToolResult | null> {
    const requestedUrl = new URL(params.url);
    const packageName = this.tryParseNpmPackageName(requestedUrl);
    if (!packageName) {
      return null;
    }

    const metadataUrl = `https://registry.npmjs.org/${packageName}/latest`;
    const metadataResponse = await client.webFetch({
      url: metadataUrl,
      maxChars: Math.min(maxChars, 20000)
    });

    if (metadataResponse.status < 200 || metadataResponse.status >= 300) {
      return null;
    }

    const metadata = this.tryParseJsonObject(metadataResponse.content);
    if (!metadata) {
      return null;
    }

    const name = this.tryGetString(metadata["name"]) ?? packageName;
    const version = this.tryGetString(metadata["version"]);
    const description = this.tryGetString(metadata["description"]);
    const license = this.tryGetString(metadata["license"]);
    const repositoryUrl = this.tryGetRepositoryUrl(metadata["repository"]);
    const homepageUrl = this.tryGetString(metadata["homepage"]);

    let gitHubRepoUrl: string | null = null;
    if (repositoryUrl) {
      gitHubRepoUrl = this.tryNormalizeGitHubRepoUrl(repositoryUrl);
    }

    let readmeText: string | null = null;
    let readmeTruncated = false;

    if (gitHubRepoUrl) {
      const readmeResult = await this.tryFetchGitHubReadme(
        client,
        gitHubRepoUrl,
        maxChars
      );
      if (readmeResult) {
        readmeText = readmeResult.content;
        readmeTruncated = readmeResult.truncated;
      }
    }

    const lines: string[] = [];
    lines.push(`# ${name}`);
    lines.push("");
    lines.push(`URL solicitada: ${params.url}`);
    lines.push("");
    if (description) {
      lines.push(`Descripción: ${description}`);
    }
    if (version) {
      lines.push(`Última versión: ${version}`);
    }
    if (license) {
      lines.push(`Licencia: ${license}`);
    }
    if (homepageUrl) {
      lines.push(`Página principal: ${homepageUrl}`);
    }
    if (gitHubRepoUrl) {
      lines.push(`Repositorio: ${gitHubRepoUrl}`);
    } else if (repositoryUrl) {
      lines.push(`Repositorio: ${repositoryUrl}`);
    }

    if (readmeText) {
      lines.push("");
      lines.push("## README");
      lines.push("");
      lines.push(readmeText);
    }

    const combined = lines.join("\n").trim() + "\n";
    const shouldTrim = combined.length > maxChars;
    const content = shouldTrim ? combined.slice(0, maxChars) : combined;

    return {
      content,
      status: 200,
      content_type: "text/markdown",
      truncated: shouldTrim || readmeTruncated || metadataResponse.truncated,
      url: params.url
    };
  }

  /**
   * Attempts to parse an npm package name from an npmjs.com package page URL.
   *
   * @param url - Parsed URL
   * @returns npm package name (e.g. "chalk" or "@scope/name") or null
   */
  private tryParseNpmPackageName(url: URL): string | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "www.npmjs.com" && hostname !== "npmjs.com") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return null;
    }
    if (segments[0] !== "package") {
      return null;
    }

    const first = segments[1];
    if (!first) {
      return null;
    }

    if (first.startsWith("@")) {
      const second = segments[2];
      if (!second) {
        return null;
      }
      return `${first}/${second}`;
    }

    return first;
  }

  /**
   * Tries to parse a JSON object from a string.
   *
   * @param input - JSON string
   * @returns Parsed object or null
   */
  private tryParseJsonObject(input: string): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(input);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Extracts a string from an unknown value if possible.
   *
   * @param value - Unknown input
   * @returns Trimmed string or null
   */
  private tryGetString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Extracts a repository URL from npm metadata.
   *
   * @param repository - Repository field value
   * @returns Normalized URL string or null
   */
  private tryGetRepositoryUrl(repository: unknown): string | null {
    if (typeof repository === "string") {
      return this.normalizeRepositoryUrl(repository);
    }

    if (typeof repository === "object" && repository !== null && !Array.isArray(repository)) {
      const record = repository as Record<string, unknown>;
      const rawUrl = this.tryGetString(record["url"]);
      if (!rawUrl) {
        return null;
      }
      return this.normalizeRepositoryUrl(rawUrl);
    }

    return null;
  }

  /**
   * Normalizes common git repository URL schemes into an https URL.
   *
   * @param rawUrl - Raw repository URL from metadata
   * @returns Normalized URL string or null
   */
  private normalizeRepositoryUrl(rawUrl: string): string | null {
    let urlText = rawUrl.trim();

    if (urlText.startsWith("git+")) {
      urlText = urlText.slice("git+".length);
    }

    if (urlText.startsWith("git://")) {
      urlText = `https://${urlText.slice("git://".length)}`;
    }

    if (urlText.endsWith(".git")) {
      urlText = urlText.slice(0, -".git".length);
    }

    try {
      const parsed = new URL(urlText);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }

  /**
   * Normalizes a GitHub repository URL to the canonical https form.
   *
   * @param repositoryUrl - Repository URL
   * @returns Canonical GitHub repo URL (https://github.com/{owner}/{repo}) or null
   */
  private tryNormalizeGitHubRepoUrl(repositoryUrl: string): string | null {
    try {
      const parsed = new URL(repositoryUrl);
      if (parsed.hostname.toLowerCase() !== "github.com") {
        return null;
      }

      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length < 2) {
        return null;
      }

      const owner = segments[0];
      const repo = segments[1];
      if (!owner || !repo) {
        return null;
      }

      return `https://github.com/${owner}/${repo}`;
    } catch {
      return null;
    }
  }

  /**
   * Attempts to fetch a GitHub repository README via raw.githubusercontent.com.
   *
   * @param client - EnriProxy client
   * @param githubRepoUrl - Canonical GitHub repo URL
   * @param maxChars - Maximum content length
   * @returns README content if found, otherwise null
   */
  private async tryFetchGitHubReadme(
    client: EnriProxyClient,
    githubRepoUrl: string,
    maxChars: number
  ): Promise<{ content: string; truncated: boolean } | null> {
    const parsed = new URL(githubRepoUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    const owner = segments[0];
    const repo = segments[1];
    if (!owner || !repo) {
      return null;
    }

    for (const branch of WebFetchTool.README_BRANCHES) {
      for (const filename of WebFetchTool.README_FILENAMES) {
        const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`;
        const response = await client.webFetch({
          url,
          maxChars
        });

        if (response.status >= 200 && response.status < 300 && response.content.trim().length > 0) {
          return {
            content: response.content,
            truncated: response.truncated
          };
        }
      }
    }

    return null;
  }

  /**
   * Formats results for MCP text output.
   *
   * @param result - Tool result
   * @returns Formatted text
   */
  public formatOutput(result: WebFetchToolResult): string {
    const truncatedNote = result.truncated ? " [TRUNCADO]" : "";
    const previewChars = Math.min(DEFAULT_TEXT_PREVIEW_CHARS, result.content.length);
    const preview = result.content.slice(0, previewChars);
    const header = `Contenido obtenido de ${result.url} (${result.content_type}, ${result.content.length} caracteres)${truncatedNote}.`;
    const previewNote =
      previewChars < result.content.length
        ? `\n\nVista previa (primeros ${previewChars} caracteres):\n\n`
        : "\n\nContenido:\n\n";

    return header + previewNote + preview;
  }
}
