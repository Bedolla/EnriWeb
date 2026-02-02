/**
 * WEB SEARCH REGISTRY VERIFIER
 *
 * Enriches `web_search` results with canonical package version information
 * fetched from official registry APIs when possible.
 *
 * Supported ecosystems:
 * - npm (registry.npmjs.org)
 * - PyPI (pypi.org JSON)
 * - crates.io (crates.io API)
 * - NuGet (.NET) (api.nuget.org v3)
 * - GitHub releases (api.github.com)
 *
 * @module tools/WebSearchRegistryVerifier
 */
import type { WebSearchResultEntry } from "../client/EnriProxyClient.js";

/**
 * Supported registry kinds for version verification.
 */
export type VerifiedRegistryKind =
  | "npm"
  | "pypi"
  | "crates"
  | "nuget"
  | "github";

/**
 * A verified version resolved from a canonical registry source.
 */
export interface VerifiedRegistryVersion {
  /**
   * Version string (as returned by the upstream registry).
   */
  readonly version: string;

  /**
   * Optional publish timestamp in ISO 8601 format.
   */
  readonly published_at?: string;

  /**
   * Source URL used to verify this version.
   */
  readonly source_url: string;
}

/**
 * Verification output for a detected registry entity.
 */
export interface VerifiedRegistryEntity {
  /**
   * Registry kind.
   */
  readonly kind: VerifiedRegistryKind;

  /**
   * Entity identifier (package name, package ID, or repo slug).
   */
  readonly name: string;

  /**
   * Latest stable version, when available.
   */
  readonly latest_stable?: VerifiedRegistryVersion;

  /**
   * Latest prerelease version, when available.
   */
  readonly latest_prerelease?: VerifiedRegistryVersion;

  /**
   * Verification status.
   */
  readonly status: "ok" | "error";

  /**
   * Error message when {@link status} is `error`.
   */
  readonly error?: string;
}

/**
 * Dependencies for {@link WebSearchRegistryVerifier}.
 */
export interface WebSearchRegistryVerifierDeps {
  /**
   * Fetch implementation (Node.js global fetch in production).
   */
  readonly fetchImpl: typeof fetch;

  /**
   * Timeout for registry HTTP requests.
   */
  readonly timeoutMs: number;

  /**
   * Cache TTL in milliseconds for registry lookups.
   */
  readonly cacheTtlMs: number;

  /**
   * Maximum number of entities to verify per `web_search` call.
   *
   * @remarks
   * This protects against excessive outbound traffic when many registry URLs
   * appear in results.
   */
  readonly maxEntitiesPerCall: number;

  /**
   * Optional GitHub token to increase API rate limits.
   */
  readonly githubToken?: string;
}

/**
 * Cached entry wrapper.
 */
interface CacheEntry {
  /**
   * Cached value.
   */
  readonly value: VerifiedRegistryEntity;

  /**
   * Expiration epoch in ms.
   */
  readonly expiresAtMs: number;
}

/**
 * SemVer representation for comparisons.
 */
interface SemVerParsed {
  /**
   * Original version string as seen upstream (normalized to omit leading "v").
   */
  readonly raw: string;

  /**
   * Major version.
   */
  readonly major: number;

  /**
   * Minor version.
   */
  readonly minor: number;

  /**
   * Patch version.
   */
  readonly patch: number;

  /**
   * Prerelease identifiers (dot-separated).
   */
  readonly prerelease: readonly string[];
}

/**
 * NuGet service index cache data.
 */
interface NuGetServiceIndexCache {
  /**
   * Package base address resource URL.
   */
  readonly packageBaseAddressUrl: string | null;

  /**
   * Registration base URL.
   */
  readonly registrationsBaseUrl: string | null;

  /**
   * Expiration epoch in ms.
   */
  readonly expiresAtMs: number;
}

/**
 * Enriches web search results with registry version verification.
 */
export class WebSearchRegistryVerifier {
  /**
   * NuGet V3 service index endpoint.
   */
  private static readonly NUGET_SERVICE_INDEX_URL: string =
    "https://api.nuget.org/v3/index.json";

  /**
   * Default concurrency for registry verification.
   */
  private static readonly DEFAULT_CONCURRENCY: number = 3;

  /**
   * Dependencies.
   */
  private readonly deps: WebSearchRegistryVerifierDeps;

  /**
   * In-memory TTL cache.
   */
  private readonly cache: Map<string, CacheEntry>;

  /**
   * Cached NuGet service index resolution.
   */
  private nugetServiceIndexCache: NuGetServiceIndexCache | null;

  /**
   * Creates a new {@link WebSearchRegistryVerifier}.
   *
   * @param deps - Dependencies
   */
  public constructor(deps: WebSearchRegistryVerifierDeps) {
    this.deps = deps;
    this.cache = new Map<string, CacheEntry>();
    this.nugetServiceIndexCache = null;
  }

  /**
   * Attempts to verify canonical versions for registry entities found in search results.
   *
   * @param results - Search results
   * @returns Verified entities (best-effort)
   */
  public async verifyFromSearchResults(
    results: WebSearchResultEntry[]
  ): Promise<VerifiedRegistryEntity[]> {
    const candidates = this.collectCandidates(results);
    if (candidates.length === 0) {
      return [];
    }

    const tasks = candidates.map(
      (candidate) => async (): Promise<VerifiedRegistryEntity> => {
        return await this.verifyCandidate(candidate.kind, candidate.name);
      }
    );

    return await this.runWithConcurrencyLimit(
      tasks,
      WebSearchRegistryVerifier.DEFAULT_CONCURRENCY
    );
  }

  /**
   * Collects registry candidates from search result URLs.
   *
   * @param results - Search results
   * @returns Candidate list
   */
  private collectCandidates(
    results: WebSearchResultEntry[]
  ): Array<{ kind: VerifiedRegistryKind; name: string }> {
    const unique = new Set<string>();
    const candidates: Array<{ kind: VerifiedRegistryKind; name: string }> = [];

    for (const entry of results) {
      if (!entry.url || candidates.length >= this.deps.maxEntitiesPerCall) {
        break;
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(entry.url);
      } catch {
        continue;
      }

      const npmName = this.tryParseNpmPackageName(parsedUrl);
      if (npmName) {
        const key = `npm:${npmName}`;
        if (!unique.has(key)) {
          unique.add(key);
          candidates.push({ kind: "npm", name: npmName });
        }
        continue;
      }

      const pypiName = this.tryParsePyPiProjectName(parsedUrl);
      if (pypiName) {
        const key = `pypi:${pypiName}`;
        if (!unique.has(key)) {
          unique.add(key);
          candidates.push({ kind: "pypi", name: pypiName });
        }
        continue;
      }

      const cratesName = this.tryParseCratesName(parsedUrl);
      if (cratesName) {
        const key = `crates:${cratesName}`;
        if (!unique.has(key)) {
          unique.add(key);
          candidates.push({ kind: "crates", name: cratesName });
        }
        continue;
      }

      const nugetId = this.tryParseNuGetPackageId(parsedUrl);
      if (nugetId) {
        const key = `nuget:${nugetId.toLowerCase()}`;
        if (!unique.has(key)) {
          unique.add(key);
          candidates.push({ kind: "nuget", name: nugetId });
        }
        continue;
      }

      const repo = this.tryParseGitHubRepoSlug(parsedUrl);
      if (repo) {
        const key = `github:${repo.toLowerCase()}`;
        if (!unique.has(key)) {
          unique.add(key);
          candidates.push({ kind: "github", name: repo });
        }
        continue;
      }
    }

    return candidates;
  }

  /**
   * Verifies a single candidate, using cache when available.
   *
   * @param kind - Registry kind
   * @param name - Candidate name
   * @returns Verification result
   */
  private async verifyCandidate(
    kind: VerifiedRegistryKind,
    name: string
  ): Promise<VerifiedRegistryEntity> {
    const cacheKey = `${kind}:${name.toLowerCase()}`;
    const nowMs = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.value;
    }

    let value: VerifiedRegistryEntity;
    try {
      if (kind === "npm") {
        value = await this.verifyNpm(name);
      } else if (kind === "pypi") {
        value = await this.verifyPyPi(name);
      } else if (kind === "crates") {
        value = await this.verifyCrates(name);
      } else if (kind === "nuget") {
        value = await this.verifyNuGet(name);
      } else {
        value = await this.verifyGitHub(name);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      value = { kind, name, status: "error", error: message };
    }

    this.cache.set(cacheKey, { value, expiresAtMs: nowMs + this.deps.cacheTtlMs });
    return value;
  }

  /**
   * Runs tasks with a fixed concurrency limit.
   *
   * @param tasks - Async tasks
   * @param concurrency - Concurrency limit
   * @returns Results in original order
   */
  private async runWithConcurrencyLimit<T>(
    tasks: Array<() => Promise<T>>,
    concurrency: number
  ): Promise<T[]> {
    const results: T[] = new Array<T>(tasks.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= tasks.length) {
          return;
        }
        results[currentIndex] = await tasks[currentIndex]();
      }
    };

    const poolSize = Math.max(1, Math.min(concurrency, tasks.length));
    const workers = new Array<Promise<void>>(poolSize);
    for (let i = 0; i < poolSize; i += 1) {
      workers[i] = worker();
    }
    await Promise.all(workers);
    return results;
  }

  /**
   * Verifies npm package versions via the npm registry.
   *
   * @param packageName - npm package name (may be scoped)
   * @returns Verified registry entity
   */
  private async verifyNpm(packageName: string): Promise<VerifiedRegistryEntity> {
    const encoded = encodeURIComponent(packageName);
    const sourceUrl = `https://registry.npmjs.org/${encoded}`;
    const bodyRaw = await this.fetchJson(sourceUrl, { accept: "application/json" });
    const body = this.tryGetRecord(bodyRaw);
    if (!body) {
      throw new Error(`Unexpected npm registry response for ${sourceUrl}`);
    }

    const distTags = this.tryGetRecord(body["dist-tags"]);
    const versionsRecord = this.tryGetRecord(body["versions"]);
    const timeRecord = this.tryGetRecord(body["time"]);

    const versionKeys = versionsRecord ? Object.keys(versionsRecord) : [];
    const bestStable = this.pickBestSemVer(versionKeys, { prerelease: false });
    const bestPrerelease = this.pickBestSemVer(versionKeys, { prerelease: true });

    const distLatest = distTags ? this.tryGetNonEmptyString(distTags["latest"]) : null;
    const stableVersion =
      bestStable ??
      (distLatest && !this.isPrereleaseVersion(distLatest) ? distLatest : null);

    const stablePublishedAt =
      stableVersion && timeRecord
        ? this.tryGetNonEmptyString(timeRecord[stableVersion])
        : null;
    const prereleasePublishedAt =
      bestPrerelease && timeRecord
        ? this.tryGetNonEmptyString(timeRecord[bestPrerelease])
        : null;

    return {
      kind: "npm",
      name: packageName,
      latest_stable: stableVersion
        ? { version: stableVersion, published_at: stablePublishedAt ?? undefined, source_url: sourceUrl }
        : undefined,
      latest_prerelease: bestPrerelease
        ? {
            version: bestPrerelease,
            published_at: prereleasePublishedAt ?? undefined,
            source_url: sourceUrl
          }
        : undefined,
      status: "ok"
    };
  }

  /**
   * Verifies PyPI project versions via the PyPI JSON API.
   *
   * @param projectName - PyPI project name
   * @returns Verified registry entity
   */
  private async verifyPyPi(projectName: string): Promise<VerifiedRegistryEntity> {
    const encoded = encodeURIComponent(projectName);
    const sourceUrl = `https://pypi.org/pypi/${encoded}/json`;
    const bodyRaw = await this.fetchJson(sourceUrl, { accept: "application/json" });
    const body = this.tryGetRecord(bodyRaw);
    if (!body) {
      throw new Error(`Unexpected PyPI response for ${sourceUrl}`);
    }

    const releases = this.tryGetRecord(body["releases"]);
    const candidates: Array<{ version: string; publishedAt: string | null; prerelease: boolean }> = [];

    if (releases) {
      for (const version of Object.keys(releases)) {
        candidates.push({
          version,
          publishedAt: this.tryGetLatestPyPiUploadIso(releases[version]),
          prerelease: this.isLikelyPyPiPrerelease(version)
        });
      }
    }

    const stable = this.pickBestVersionCandidate(candidates, { prerelease: false });
    const pre = this.pickBestVersionCandidate(candidates, { prerelease: true });

    return {
      kind: "pypi",
      name: projectName,
      latest_stable: stable
        ? { version: stable.version, published_at: stable.publishedAt ?? undefined, source_url: sourceUrl }
        : undefined,
      latest_prerelease: pre
        ? { version: pre.version, published_at: pre.publishedAt ?? undefined, source_url: sourceUrl }
        : undefined,
      status: "ok"
    };
  }

  /**
   * Verifies crates.io package versions via the crates.io API.
   *
   * @param crateName - Crate name
   * @returns Verified registry entity
   */
  private async verifyCrates(crateName: string): Promise<VerifiedRegistryEntity> {
    const encoded = encodeURIComponent(crateName);
    const sourceUrl = `https://crates.io/api/v1/crates/${encoded}`;
    const bodyRaw = await this.fetchJson(sourceUrl, { accept: "application/json" });
    const body = this.tryGetRecord(bodyRaw);
    if (!body) {
      throw new Error(`Unexpected crates.io response for ${sourceUrl}`);
    }

    const versions = Array.isArray(body["versions"]) ? body["versions"] : [];
    const stableCandidates: string[] = [];
    const prereleaseCandidates: string[] = [];
    const publishedByVersion = new Map<string, string>();

    for (const item of versions) {
      const record = this.tryGetRecord(item);
      if (!record) {
        continue;
      }
      const num = this.tryGetNonEmptyString(record["num"]);
      if (!num) {
        continue;
      }
      if (record["yanked"] === true) {
        continue;
      }
      const createdAt = this.tryGetNonEmptyString(record["created_at"]);
      if (createdAt) {
        publishedByVersion.set(num, createdAt);
      }
      if (this.isPrereleaseVersion(num)) {
        prereleaseCandidates.push(num);
      } else {
        stableCandidates.push(num);
      }
    }

    const bestStable = this.pickBestSemVer(stableCandidates, { prerelease: false });
    const bestPre = this.pickBestSemVer(prereleaseCandidates, { prerelease: true });

    return {
      kind: "crates",
      name: crateName,
      latest_stable: bestStable
        ? {
            version: bestStable,
            published_at: publishedByVersion.get(bestStable) ?? undefined,
            source_url: sourceUrl
          }
        : undefined,
      latest_prerelease: bestPre
        ? {
            version: bestPre,
            published_at: publishedByVersion.get(bestPre) ?? undefined,
            source_url: sourceUrl
          }
        : undefined,
      status: "ok"
    };
  }

  /**
   * Verifies NuGet package versions via NuGet V3 endpoints.
   *
   * @param packageId - NuGet package ID
   * @returns Verified registry entity
   */
  private async verifyNuGet(packageId: string): Promise<VerifiedRegistryEntity> {
    const lowerId = packageId.toLowerCase();
    const serviceIndex = await this.getNuGetServiceIndex();

    if (!serviceIndex.packageBaseAddressUrl) {
      return {
        kind: "nuget",
        name: packageId,
        status: "error",
        error: "NuGet service index did not provide PackageBaseAddress."
      };
    }

    const versionsUrl = `${serviceIndex.packageBaseAddressUrl}${lowerId}/index.json`;
    const versionsBodyRaw = await this.fetchJson(versionsUrl, { accept: "application/json" });
    const versionsBody = this.tryGetRecord(versionsBodyRaw);
    if (!versionsBody) {
      throw new Error(`Unexpected NuGet response for ${versionsUrl}`);
    }
    const versions = Array.isArray(versionsBody["versions"]) ? versionsBody["versions"] : [];
    const versionStrings = versions
      .map((v) => (typeof v === "string" ? v : null))
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

    const bestStable = this.pickBestSemVer(versionStrings, { prerelease: false });
    const bestPre = this.pickBestSemVer(versionStrings, { prerelease: true });

    const stablePublishedAt =
      bestStable && serviceIndex.registrationsBaseUrl
        ? await this.tryFetchNuGetLeafPublishedAt(serviceIndex.registrationsBaseUrl, lowerId, bestStable)
        : null;
    const prePublishedAt =
      bestPre && serviceIndex.registrationsBaseUrl
        ? await this.tryFetchNuGetLeafPublishedAt(serviceIndex.registrationsBaseUrl, lowerId, bestPre)
        : null;

    return {
      kind: "nuget",
      name: packageId,
      latest_stable: bestStable
        ? { version: bestStable, published_at: stablePublishedAt ?? undefined, source_url: versionsUrl }
        : undefined,
      latest_prerelease: bestPre
        ? { version: bestPre, published_at: prePublishedAt ?? undefined, source_url: versionsUrl }
        : undefined,
      status: "ok"
    };
  }

  /**
   * Verifies GitHub repository releases via GitHub REST API.
   *
   * @param repoSlug - Repository slug in the form "owner/repo"
   * @returns Verified registry entity
   */
  private async verifyGitHub(repoSlug: string): Promise<VerifiedRegistryEntity> {
    const parts = repoSlug.split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) {
      return { kind: "github", name: repoSlug, status: "error", error: "Invalid repo slug." };
    }

    const sourceUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;
    const releasesRaw = await this.fetchJson(sourceUrl, {
      accept: "application/vnd.github+json",
      githubToken: this.deps.githubToken
    });
    const releases = Array.isArray(releasesRaw) ? releasesRaw : [];

    const stableCandidates: Array<{ version: string; publishedAt: string | null; prerelease: boolean }> = [];
    const preCandidates: Array<{ version: string; publishedAt: string | null; prerelease: boolean }> = [];

    for (const item of releases) {
      const record = this.tryGetRecord(item);
      if (!record) {
        continue;
      }
      if (record["draft"] === true) {
        continue;
      }
      const tagNameRaw = this.tryGetNonEmptyString(record["tag_name"]);
      if (!tagNameRaw) {
        continue;
      }
      const tagName = tagNameRaw.startsWith("v") ? tagNameRaw.slice(1) : tagNameRaw;
      const publishedAt = this.tryGetNonEmptyString(record["published_at"]);
      const isPrerelease = record["prerelease"] === true;
      const candidate = { version: tagName, publishedAt: publishedAt ?? null, prerelease: isPrerelease };
      if (isPrerelease) {
        preCandidates.push(candidate);
      } else {
        stableCandidates.push(candidate);
      }
    }

    const bestStable = this.pickBestVersionCandidate(stableCandidates, { prerelease: false });
    const bestPre = this.pickBestVersionCandidate(preCandidates, { prerelease: true });

    return {
      kind: "github",
      name: repoSlug,
      latest_stable: bestStable
        ? { version: bestStable.version, published_at: bestStable.publishedAt ?? undefined, source_url: sourceUrl }
        : undefined,
      latest_prerelease: bestPre
        ? { version: bestPre.version, published_at: bestPre.publishedAt ?? undefined, source_url: sourceUrl }
        : undefined,
      status: "ok"
    };
  }

  /**
   * Performs an HTTP GET expecting a JSON response.
   *
   * @param url - Target URL
   * @param options - Request options
   * @returns Parsed JSON object/array
   */
  private async fetchJson(
    url: string,
    options: { accept: string; githubToken?: string }
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deps.timeoutMs);

    const headers: Record<string, string> = {
      Accept: options.accept,
      "User-Agent": "enriweb"
    };
    if (options.githubToken && options.githubToken.trim()) {
      headers["Authorization"] = `Bearer ${options.githubToken.trim()}`;
    }

    try {
      const response = await this.deps.fetchImpl(url, {
        method: "GET",
        headers,
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Attempts to parse the npm package name from an npmjs.com URL.
   *
   * @param url - Parsed URL
   * @returns Package name or null
   */
  private tryParseNpmPackageName(url: URL): string | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "www.npmjs.com" && hostname !== "npmjs.com") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== "package") {
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
   * Attempts to parse the PyPI project name from a pypi.org URL.
   *
   * @param url - Parsed URL
   * @returns Project name or null
   */
  private tryParsePyPiProjectName(url: URL): string | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "pypi.org") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== "project") {
      return null;
    }

    const name = segments[1];
    return name ? name : null;
  }

  /**
   * Attempts to parse the crate name from a crates.io URL.
   *
   * @param url - Parsed URL
   * @returns Crate name or null
   */
  private tryParseCratesName(url: URL): string | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "crates.io") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== "crates") {
      return null;
    }

    const name = segments[1];
    return name ? name : null;
  }

  /**
   * Attempts to parse a NuGet package ID from a nuget.org URL.
   *
   * @param url - Parsed URL
   * @returns NuGet package ID or null
   */
  private tryParseNuGetPackageId(url: URL): string | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "www.nuget.org" && hostname !== "nuget.org") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2 || segments[0] !== "packages") {
      return null;
    }

    const id = segments[1];
    return id ? id : null;
  }

  /**
   * Attempts to parse a GitHub repository slug from a github.com URL.
   *
   * @param url - Parsed URL
   * @returns Repo slug (owner/repo) or null
   */
  private tryParseGitHubRepoSlug(url: URL): string | null {
    const hostname = url.hostname.toLowerCase();
    if (hostname !== "github.com") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    const owner = segments[0];
    const repo = segments[1];
    if (!owner || !repo) {
      return null;
    }

    return `${owner}/${repo}`;
  }

  /**
   * Returns a record if the input is a plain object.
   *
   * @param value - Unknown value
   * @returns Record or null
   */
  private tryGetRecord(value: unknown): Record<string, unknown> | null {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  /**
   * Returns a non-empty string if possible.
   *
   * @param value - Unknown value
   * @returns Trimmed string or null
   */
  private tryGetNonEmptyString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Determines whether a version string is a prerelease using SemVer rules.
   *
   * @param version - Version string
   * @returns True when prerelease
   */
  private isPrereleaseVersion(version: string): boolean {
    return version.includes("-");
  }

  /**
   * Best-effort prerelease detection for PyPI version strings.
   *
   * @param version - Version string
   * @returns True when prerelease-like
   */
  private isLikelyPyPiPrerelease(version: string): boolean {
    const lower = version.toLowerCase();
    if (lower.includes("-")) {
      return true;
    }
    if (/(?:^|[._-])(?:a|b|rc|dev|alpha|beta|pre|preview)\d*/.test(lower)) {
      return true;
    }
    return false;
  }

  /**
   * Picks the best SemVer candidate from a list of versions.
   *
   * @param versions - Version list
   * @param options - Selection options
   * @returns Best version string or null
   */
  private pickBestSemVer(
    versions: readonly string[],
    options: { prerelease: boolean }
  ): string | null {
    let best: SemVerParsed | null = null;
    for (const raw of versions) {
      const parsed = this.tryParseSemVer(raw);
      if (!parsed) {
        continue;
      }
      const isPre = parsed.prerelease.length > 0;
      if (options.prerelease !== isPre) {
        continue;
      }
      if (!best || this.compareSemVer(parsed, best) > 0) {
        best = parsed;
      }
    }
    return best ? best.raw : null;
  }

  /**
   * Picks the best candidate from stable or prerelease sets.
   *
   * @param candidates - Candidate list
   * @param options - Selection options
   * @returns Best candidate or null
   */
  private pickBestVersionCandidate(
    candidates: ReadonlyArray<{
      version: string;
      publishedAt: string | null;
      prerelease: boolean;
    }>,
    options: { prerelease: boolean }
  ): { version: string; publishedAt: string | null; prerelease: boolean } | null {
    const filtered = candidates.filter((c) => c.prerelease === options.prerelease);
    if (filtered.length === 0) {
      return null;
    }

    const semverParsed = filtered
      .map((c) => ({ candidate: c, parsed: this.tryParseSemVer(c.version) }))
      .filter(
        (x): x is {
          candidate: { version: string; publishedAt: string | null; prerelease: boolean };
          parsed: SemVerParsed;
        } => x.parsed !== null
      );

    if (semverParsed.length > 0) {
      let best = semverParsed[0];
      for (const item of semverParsed.slice(1)) {
        if (this.compareSemVer(item.parsed, best.parsed) > 0) {
          best = item;
        }
      }
      return best.candidate;
    }

    let bestByTime = filtered[0];
    for (const item of filtered.slice(1)) {
      if (item.publishedAt && bestByTime.publishedAt) {
        if (item.publishedAt > bestByTime.publishedAt) {
          bestByTime = item;
        }
      } else if (item.publishedAt && !bestByTime.publishedAt) {
        bestByTime = item;
      }
    }
    return bestByTime;
  }

  /**
   * Parses SemVer strings (best-effort).
   *
   * @param raw - Version string
   * @returns Parsed semver or null
   */
  private tryParseSemVer(raw: string): SemVerParsed | null {
    const trimmed = raw.trim();
    const normalized = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
    const match =
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        normalized
      );
    if (!match) {
      return null;
    }
    const major = Number.parseInt(match[1] ?? "", 10);
    const minor = Number.parseInt(match[2] ?? "", 10);
    const patch = Number.parseInt(match[3] ?? "", 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
      return null;
    }
    const prereleaseRaw = match[4];
    const prerelease = prereleaseRaw
      ? prereleaseRaw.split(".").filter((p) => p.length > 0)
      : [];

    return { raw: normalized, major, minor, patch, prerelease };
  }

  /**
   * Compares two SemVer values.
   *
   * @param a - SemVer a
   * @param b - SemVer b
   * @returns Comparison result
   */
  private compareSemVer(a: SemVerParsed, b: SemVerParsed): number {
    if (a.major !== b.major) {
      return a.major - b.major;
    }
    if (a.minor !== b.minor) {
      return a.minor - b.minor;
    }
    if (a.patch !== b.patch) {
      return a.patch - b.patch;
    }

    const aPre = a.prerelease;
    const bPre = b.prerelease;
    if (aPre.length === 0 && bPre.length === 0) {
      return 0;
    }
    if (aPre.length === 0) {
      return 1;
    }
    if (bPre.length === 0) {
      return -1;
    }

    const len = Math.max(aPre.length, bPre.length);
    for (let i = 0; i < len; i += 1) {
      const aId = aPre[i];
      const bId = bPre[i];
      if (aId === undefined) {
        return -1;
      }
      if (bId === undefined) {
        return 1;
      }
      const aNum = this.tryParseInt(aId);
      const bNum = this.tryParseInt(bId);
      if (aNum !== null && bNum !== null) {
        if (aNum !== bNum) {
          return aNum - bNum;
        }
        continue;
      }
      if (aNum !== null && bNum === null) {
        return -1;
      }
      if (aNum === null && bNum !== null) {
        return 1;
      }
      if (aId !== bId) {
        return aId < bId ? -1 : 1;
      }
    }
    return 0;
  }

  /**
   * Attempts to parse an integer, returning null for non-numeric identifiers.
   *
   * @param value - String value
   * @returns Parsed integer or null
   */
  private tryParseInt(value: string): number | null {
    if (!/^\d+$/.test(value)) {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Extracts the most recent PyPI upload timestamp for a release entry.
   *
   * @param releaseFiles - Releases[version] value
   * @returns Latest upload time in ISO 8601 or null
   */
  private tryGetLatestPyPiUploadIso(releaseFiles: unknown): string | null {
    if (!Array.isArray(releaseFiles)) {
      return null;
    }

    let best: string | null = null;
    for (const item of releaseFiles) {
      const record = this.tryGetRecord(item);
      if (!record) {
        continue;
      }
      const uploadTime = this.tryGetNonEmptyString(record["upload_time_iso_8601"]);
      if (!uploadTime) {
        continue;
      }
      if (!best || uploadTime > best) {
        best = uploadTime;
      }
    }
    return best;
  }

  /**
   * Resolves NuGet V3 endpoints from the service index, with caching.
   *
   * @returns Service index cache
   */
  private async getNuGetServiceIndex(): Promise<NuGetServiceIndexCache> {
    const nowMs = Date.now();
    if (this.nugetServiceIndexCache && this.nugetServiceIndexCache.expiresAtMs > nowMs) {
      return this.nugetServiceIndexCache;
    }

    const bodyRaw = await this.fetchJson(WebSearchRegistryVerifier.NUGET_SERVICE_INDEX_URL, {
      accept: "application/json"
    });
    const body = this.tryGetRecord(bodyRaw);
    if (!body) {
      throw new Error("Unexpected NuGet service index response.");
    }
    const resources = Array.isArray(body["resources"]) ? body["resources"] : [];

    let packageBase: string | null = null;
    let registrations: string | null = null;

    for (const item of resources) {
      const record = this.tryGetRecord(item);
      if (!record) {
        continue;
      }
      const id = this.tryGetNonEmptyString(record["@id"]);
      const typeValue = record["@type"];
      const types: string[] = [];
      if (typeof typeValue === "string") {
        types.push(typeValue);
      } else if (Array.isArray(typeValue)) {
        for (const t of typeValue) {
          if (typeof t === "string") {
            types.push(t);
          }
        }
      }

      if (!id || types.length === 0) {
        continue;
      }

      if (!packageBase && types.some((t) => t.startsWith("PackageBaseAddress"))) {
        packageBase = id.endsWith("/") ? id : `${id}/`;
      }
      if (!registrations && types.some((t) => t.startsWith("RegistrationsBaseUrl"))) {
        registrations = id.endsWith("/") ? id : `${id}/`;
      }
    }

    this.nugetServiceIndexCache = {
      packageBaseAddressUrl: packageBase,
      registrationsBaseUrl: registrations,
      expiresAtMs: nowMs + 24 * 60 * 60 * 1000
    };
    return this.nugetServiceIndexCache;
  }

  /**
   * Attempts to fetch NuGet registration leaf to extract published timestamp.
   *
   * @param registrationsBaseUrl - Registrations base URL
   * @param lowerId - Lowercase package ID
   * @param version - Version string
   * @returns Published ISO 8601 timestamp or null
   */
  private async tryFetchNuGetLeafPublishedAt(
    registrationsBaseUrl: string,
    lowerId: string,
    version: string
  ): Promise<string | null> {
    const leafUrl = `${registrationsBaseUrl}${lowerId}/${encodeURIComponent(version)}.json`;
    try {
      const bodyRaw = await this.fetchJson(leafUrl, { accept: "application/json" });
      const body = this.tryGetRecord(bodyRaw);
      if (!body) {
        return null;
      }
      const catalog = this.tryGetRecord(body["catalogEntry"]);
      if (!catalog) {
        return null;
      }
      return this.tryGetNonEmptyString(catalog["published"]);
    } catch {
      return null;
    }
  }
}
