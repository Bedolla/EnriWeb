/**
 * npm package-page projection for the web_fetch tool.
 *
 * @remarks
 * npm package pages answer with a marketing shell; this projection queries
 * the official registry metadata and fetches the README from the resolved
 * repository (GitHub raw with branch preference and a bounded worker pool),
 * stitching a structured Spanish result with early-exit on the first hit.
 * Extracted from {@link WebFetchTool} as a pure collaborator.
 *
 * Size note (~590 lines, alert zone by design): the npm path owns metadata
 * fetch, version pinning, the README pool and the stitched composition as
 * one cohesive pipeline; the shared registry transport already lives in
 * WebSearchRegistryHttpReader. Splitting is tracked debt; any future edit
 * must extract the touched unit instead of growing this file.
 *
 * @module tools/WebFetchNpmProjection
 */

import type { EnriProxyClient } from "../client/EnriProxyClient.js";
import type { WebFetchToolParams, WebFetchToolResult } from "./WebFetchTool.js";
import { sliceUtf8Safe } from "../shared/Utf8SafeTextSlicer.js";

/**
 * README sub-fetch projection traveling to raw.githubusercontent.com.
 */
interface WebFetchReadmeProjection {
  /**
   * Effective content flavor for the README page.
   */
  readonly format: "text" | "markdown" | "html";

  /**
   * Effective content scope for the README page.
   */
  readonly content: "main" | "full";

  /**
   * Whether to append the page link inventory.
   */
  readonly includeLinks: boolean;

  /**
   * Whether to append the extended metadata block.
   */
  readonly includeMetadata: boolean;

  /**
   * Optional anchor selector restricting the projection to one section.
   */
  readonly anchor?: string;

  /**
   * Optional extraction prompt honored by the README sub-fetch.
   */
  readonly prompt?: string;
}

/**
 * Maximum concurrent README sub-fetches.
 *
 * @remarks
 * Bounds the npm fan-out while keeping the worst case near one timeout for
 * fast 404s; candidates dispatch in preference order.
 */
const README_FETCH_CONCURRENCY = 3;

/**
 * Bounds one npm sub-fetch to the short subfetch timeout.
 *
 * @param signal - Optional caller abort signal.
 * @returns Combined signal, or undefined when the caller passed none.
 */
function subfetchSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
  if (signal === undefined) {
    return AbortSignal.timeout(README_SUBFETCH_TIMEOUT_MS);
  }
  if (signal.aborted) {
    return signal;
  }
  return AbortSignal.any([signal, AbortSignal.timeout(README_SUBFETCH_TIMEOUT_MS)]);
}

/**
 * Per-subfetch timeout (ms) for npm registry/metadata/README reads.
 *
 * @remarks
 * Raw files answer in milliseconds; a hung candidate must not consume the
 * whole tool budget. Combined with the pool, the npm path stays near one
 * tool timeout even when every candidate hangs.
 */
const README_SUBFETCH_TIMEOUT_MS = 20_000;

/**
 * Coordinates parsed from an npmjs.com package page URL.
 */
interface NpmPackagePageRef {
  /**
   * Package name (e.g. "chalk" or "@scope/name").
   */
  readonly name: string;

  /**
   * Pinned version from the `/v/<version>` path segment, when present.
   */
  readonly version?: string;
}

/**
 * npm package-page projection collaborator.
 */
export class WebFetchNpmProjection {
  /**
   * Readme file candidates commonly used in GitHub repositories.
   */
  private static readonly README_FILENAMES: readonly string[] = [
    "README.md",
    "readme.md",
    "README.MD",
    "README.rst",
    "README.txt"
  ];

  /**
   * Default branches to try when resolving GitHub raw README URLs.
   */
  private static readonly README_BRANCHES: readonly string[] = ["main", "master"];

  /**
   * Attempts to provide a higher-quality fetch for npm package pages.
   *
   * @param params - Tool parameters
   * @param client - EnriProxy client
   * @param maxChars - Maximum content length to return
   * @param projection - Effective projection traveling to README sub-fetches
   * @param signal - Optional caller abort signal
   * @returns Tool result if the URL is an npm package page, otherwise null
   */
  public async tryExecuteNpmPackageFetch(
    params: WebFetchToolParams & { readonly url: string },
    client: EnriProxyClient,
    maxChars: number,
    projection: WebFetchReadmeProjection,
    signal?: AbortSignal
  ): Promise<WebFetchToolResult | null> {
    const requestedUrl = new URL(params.url);
    const packageRef = this.tryParseNpmPackagePageRef(requestedUrl);
    if (!packageRef) {
      return null;
    }

    // A pinned `/v/<version>` page resolves its own registry manifest; only
    // the unversioned page asks for `/latest` (small payload, parity with
    // EnriProxy's registry tier).
    const metadataUrl =
      packageRef.version !== undefined
        ? `https://registry.npmjs.org/${encodeURIComponent(packageRef.name)}/${encodeURIComponent(packageRef.version)}`
        : `https://registry.npmjs.org/${encodeURIComponent(packageRef.name)}/latest`;
    // A signal that never fires stands in for the caller when it passed
    // none, so subfetch timeouts are labeled as timeouts (not cancellations).
    const callerSignal: AbortSignal = signal ?? new AbortController().signal;
    let metadataResponse;
    try {
      metadataResponse = await client.webFetch(
        {
          url: metadataUrl,
          maxChars: Math.min(maxChars, 20000)
        },
        subfetchSignal(signal),
        { callerSignal, subfetchTimeoutMs: README_SUBFETCH_TIMEOUT_MS }
      );
    } catch (error) {
      // Transport failures on the metadata leg (proxy 5xx, subfetch timeout)
      // degrade to the generic fetch path instead of failing the whole call;
      // only a genuine caller abort propagates.
      if (signal?.aborted) {
        throw error;
      }
      return null;
    }

    if (metadataResponse.status < 200 || metadataResponse.status >= 300) {
      return null;
    }

    const metadata = this.tryParseJsonObject(metadataResponse.content);
    if (!metadata) {
      return null;
    }

    const name = this.tryGetString(metadata["name"]) ?? packageRef.name;
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
    let readmeCursor: string | undefined;
    let readmeTotalChars: number | undefined;

    if (gitHubRepoUrl) {
      const readmeResult = await this.tryFetchGitHubReadme(
        client,
        gitHubRepoUrl,
        maxChars,
        projection,
        signal
      );
      if (readmeResult) {
        readmeText = readmeResult.content;
        readmeTruncated = readmeResult.truncated;
        readmeCursor = readmeResult.cursor;
        readmeTotalChars = readmeResult.totalChars;
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
    const versionLabel: string | null = version ?? packageRef.version ?? null;
    if (versionLabel) {
      // A pinned `/v/<version>` page labels the requested version; only the
      // unversioned page reports the rolling "latest".
      lines.push(
        packageRef.version !== undefined
          ? `Versión solicitada: ${versionLabel}`
          : `Última versión: ${versionLabel}`
      );
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
    const content = shouldTrim ? sliceUtf8Safe(combined, 0, maxChars) : combined;

    return {
      content,
      status: 200,
      content_type: "text/markdown",
      truncated: shouldTrim || readmeTruncated || metadataResponse.truncated,
      url: params.url,
      // The winning README sub-fetch may have emitted a continuation cursor
      // for its raw capture: propagate it (plus the capture total) so the
      // model can paginate without re-downloading.
      ...(readmeCursor
        ? { cursor: readmeCursor, total_chars: readmeTotalChars, has_more: true }
        : { total_chars: combined.length, has_more: shouldTrim }),
      applied_max_chars: maxChars
    };
  }

  /**
   * Attempts to parse package coordinates from an npmjs.com package page URL.
   *
   * @remarks
   * Versioned pages (`/package/<name>/v/<version>`, including scoped
   * packages) pin the registry manifest to the requested version; every
   * other form resolves through `/latest`.
   *
   * @param url - Parsed URL
   * @returns Package name plus optional pinned version, or null when the URL
   *   is not an npm package page
   */
  private tryParseNpmPackagePageRef(url: URL): NpmPackagePageRef | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "www.npmjs.com" && hostname !== "npmjs.com") {
      return null;
    }

    // Path segments may arrive percent-encoded (e.g. `%40scope%2Fname` when
    // copied from the registry); decode before parsing so scoped packages
    // resolve to `@scope/name` like their canonical page form.
    const segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((segment: string): string => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
    if (segments.length < 2) {
      return null;
    }
    if (segments[0] !== "package") {
      return null;
    }

    // Reads the pinned version from the segments starting at `from`.
    const readPinnedVersion = (from: number): string | undefined => {
      const marker: string | undefined = segments[from];
      const value: string | undefined = segments[from + 1];
      return marker === "v" && value !== undefined && value.length > 0 ? value : undefined;
    };

    const first = segments[1];
    if (!first) {
      return null;
    }

    // A single percent-encoded segment (`%40scope%2Fname`) decodes to a name
    // that already contains the slash; split it back into scope + name.
    if (first.startsWith("@") && first.includes("/")) {
      const [scope, name] = first.split("/");
      if (!scope || !name) {
        return null;
      }
      return { name: `${scope}/${name}`, version: readPinnedVersion(2) };
    }

    if (first.startsWith("@")) {
      const second = segments[2];
      if (!second) {
        return null;
      }
      return { name: `${first}/${second}`, version: readPinnedVersion(3) };
    }

    return { name: first, version: readPinnedVersion(2) };
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

    if (urlText.startsWith("github:")) {
      urlText = `https://github.com/${urlText.slice("github:".length)}`;
    }
    const scpMatch: RegExpMatchArray | null = urlText.match(/^git@([^:]+):(.+)$/u);
    if (scpMatch) {
      urlText = `https://${scpMatch[1]}/${scpMatch[2]}`;
    }

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
      const repoRaw = segments[1];
      if (!owner || !repoRaw) {
        return null;
      }
      const repo: string = repoRaw.replace(/\.git$/iu, "");

      return `https://github.com/${owner}/${repo}`;
    } catch {
      return null;
    }
  }

  /**
   * Attempts to fetch a GitHub repository README via raw.githubusercontent.com.
   *
   * @remarks
   * Candidates dispatch in preference order through a bounded worker pool;
   * the first completed hit wins and aborts the stragglers, so the common
   * case costs one fast fetch instead of the slowest of ten. Projection
   * fields travel to the README sub-fetches; the registry metadata fetch
   * stays raw because its JSON is parsed.
   *
   * @param client - EnriProxy client
   * @param githubRepoUrl - Canonical GitHub repo URL
   * @param maxChars - Maximum content length
   * @param projection - Effective projection for the README page
   * @param signal - Optional caller abort signal
   * @returns README content with pagination fields, or null
   */
  private async tryFetchGitHubReadme(
    client: EnriProxyClient,
    githubRepoUrl: string,
    maxChars: number,
    projection: WebFetchReadmeProjection,
    signal?: AbortSignal
  ): Promise<{ content: string; truncated: boolean; cursor?: string; totalChars?: number } | null> {
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

    const candidates: string[] = [];
    for (const branch of WebFetchNpmProjection.README_BRANCHES) {
      for (const filename of WebFetchNpmProjection.README_FILENAMES) {
        candidates.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`);
      }
    }
    const controller = new AbortController();
    const onCallerAbort = (): void => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }
    try {
      let nextIndex = 0;
      let hit: { content: string; truncated: boolean; cursor?: string; totalChars?: number } | null = null;
      const worker = async (): Promise<void> => {
        while (hit === null) {
          const candidateIndex = nextIndex;
          nextIndex += 1;
          if (candidateIndex >= candidates.length) {
            return;
          }
          if (controller.signal.aborted) {
            return;
          }
          const candidateUrl: string = candidates[candidateIndex] ?? "";
          let response;
          try {
            response = await client.webFetch(
              {
                url: candidateUrl,
                maxChars,
                format: projection.format,
                content: projection.content,
                includeLinks: projection.includeLinks,
                includeMetadata: projection.includeMetadata,
                ...(projection.anchor !== undefined ? { anchor: projection.anchor } : {}),
                ...(projection.prompt !== undefined ? { prompt: projection.prompt } : {})
              },
              subfetchSignal(controller.signal),
              { callerSignal: controller.signal, subfetchTimeoutMs: README_SUBFETCH_TIMEOUT_MS }
            );
          } catch (error) {
            // One candidate failing (404/timeout) must not orphan the rest,
            // but a CALLER cancellation is not a candidate failure: it
            // propagates so the npm projection surfaces an aborted call
            // instead of composing a normal result for a cancelled request
            // (same contract as the metadata leg above).
            if (signal?.aborted === true) {
              throw error;
            }
            continue;
          }
          if (hit !== null) {
            return;
          }
          if (response.status >= 200 && response.status < 300 && response.content.trim().length > 0) {
            hit = {
              content: response.content,
              truncated: response.truncated,
              cursor: response.cursor,
              totalChars: response.total_chars
            };
            controller.abort();
          }
        }
      };
      const workers: Array<Promise<void>> = [];
      for (let i = 0; i < Math.min(README_FETCH_CONCURRENCY, candidates.length); i += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);
      return hit;
    } finally {
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }

}
