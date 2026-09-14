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
 *
 * @remarks Size note (~1470 lines, documented exception to the <=700
 * policy): the verifier intentionally keeps one module per concern-free
 * boundary — URL candidate detection, the five ecosystem adapters (npm,
 * PyPI, crates.io, NuGet, GitHub), semantic-version ranking, and the
 * TTL/LRU caches — because the adapters share the failure-normalization
 * and cache-key invariants that a split would otherwise duplicate. The
 * bounded JSON transport (capped streaming, timeouts, Link pagination)
 * was extracted to {@link WebSearchRegistryHttpReader} per the AR-9
 * touch-extraction rule; a per-ecosystem file split remains the documented
 * follow-up for the adapters themselves.
 */
import type { WebSearchResultEntry } from "../client/EnriProxyClient.js";
import { WebSearchRegistryHttpReader } from "./WebSearchRegistryHttpReader.js";
import { sliceUtf8Safe } from "../shared/Utf8SafeTextSlicer.js";

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
   * Patch version (0 when the upstream string only carries major.minor).
   */
  readonly patch: number;

  /**
   * Fourth numeric component (NuGet-style `1.0.0.0`), compared after patch.
   */
  readonly build: number;

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
   * Capped JSON HTTP reader owning the registry transport concerns.
   */
  private readonly httpReader: WebSearchRegistryHttpReader;

  /**
   * NuGet V3 service index endpoint.
   */
  private static readonly NUGET_SERVICE_INDEX_URL: string =
    "https://api.nuget.org/v3/index.json";

  /**
   * Maximum bytes read from one npm packument (full-version manifest).
   *
   * @remarks
   * Popular packages legitimately exceed the shared 5 MB registry cap
   * (thousands of versions with full metadata); parity with the EnriCode
   * client plane's 16 MiB download budget for the same endpoint.
   */
  private static readonly NPM_PACKUMENT_MAX_BYTES: number = 16_777_216;

  /**
   * Default concurrency for registry verification.
   */
  private static readonly DEFAULT_CONCURRENCY: number = 3;

  /**
   * Time one cached error entity stays fresh before a retry.
   */
  private static readonly ERROR_CACHE_TTL_MS: number = 60 * 1000;

  /**
   * Maximum cached verification entries (LRU eviction beyond this count).
   */
  private static readonly MAX_CACHE_ENTRIES: number = 200;

  /**
   * Dependencies.
   */
  private readonly deps: WebSearchRegistryVerifierDeps;

  /**
   * In-memory TTL cache.
   */
  private readonly cache: Map<string, CacheEntry>;

  /**
   * In-flight verification promises keyed by cache key.
   *
   * @remarks
   * Single-flight coalescing: concurrent MCP requests verifying the same
   * entity join one registry fetch instead of racing duplicates. Entries
   * are removed when the verification settles (success, error or caller
   * abort), so the map never outlives its requests.
   */
  private readonly inFlight: Map<string, Promise<VerifiedRegistryEntity>> = new Map();

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
    this.httpReader = new WebSearchRegistryHttpReader({
      fetchImpl: deps.fetchImpl,
      timeoutMs: deps.timeoutMs
    });
    this.deps = deps;
    this.cache = new Map<string, CacheEntry>();
    this.nugetServiceIndexCache = null;
  }

  /**
   * Attempts to verify canonical versions for registry entities found in search results.
   *
   * @param results - Search results
   * @param signal - Optional caller abort signal (stops queueing new verifications)
   * @returns Verified entities (best-effort)
   */
  public async verifyFromSearchResults(
    results: WebSearchResultEntry[],
    signal?: AbortSignal
  ): Promise<VerifiedRegistryEntity[]> {
    if (signal?.aborted) {
      return [];
    }
    // A non-array `results` payload (proxy shape drift) carries no
    // candidates; it must degrade to unverified instead of throwing
    // "results is not iterable" into the tool result.
    const entries: WebSearchResultEntry[] = Array.isArray(results) ? results : [];
    const candidates = this.collectCandidates(entries);
    if (candidates.length === 0) {
      return [];
    }

    const tasks = candidates.map(
      (candidate) => async (): Promise<VerifiedRegistryEntity> => {
        if (signal?.aborted) {
          throw new Error("Verificación cancelada por el cliente.");
        }
        return await this.verifyCandidate(candidate.kind, candidate.name, signal);
      }
    );

    try {
      return await this.runWithConcurrencyLimit(
        tasks,
        WebSearchRegistryVerifier.DEFAULT_CONCURRENCY
      );
    } catch (error) {
      // Cancellation must degrade to unverified results, never fail the search
      // whose results already succeeded.
      if (signal?.aborted) {
        return [];
      }
      throw error;
    }
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
      if (candidates.length >= this.deps.maxEntitiesPerCall) {
        break;
      }
      if (!entry.url) {
        continue;
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
   * Maximum `releases` pages followed per GitHub verification.
   */
  private static readonly GITHUB_RELEASES_MAX_PAGES: number = 3;

  /**
   * Verifies a single candidate, using cache when available.
   *
   * @param kind - Registry kind
   * @param name - Candidate name
   * @param signal - Optional caller abort signal forwarded to registry fetches
   * @returns Verification result
   */
  private async verifyCandidate(
    kind: VerifiedRegistryKind,
    name: string,
    signal?: AbortSignal
  ): Promise<VerifiedRegistryEntity> {
    const cacheKey = `${kind}:${name.toLowerCase()}`;
    const nowMs = Date.now();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAtMs > nowMs) {
      // LRU semantics: `Map.set` on an existing key updates the value
      // WITHOUT moving the insertion-order record (ECMAScript spec), so a
      // true recency refresh requires delete-then-set; otherwise eviction
      // below stays FIFO and evicts hot entries inserted early.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached.value;
    }

    // Single-flight: concurrent MCP requests verifying the same entity
    // join the in-flight promise instead of racing duplicate registry
    // fetches (GitHub unauthenticated quota is 60 req/h per IP).
    const inFlight: Promise<VerifiedRegistryEntity> | undefined = this.inFlight.get(cacheKey);
    if (inFlight !== undefined) {
      return await inFlight;
    }

    const verification: Promise<VerifiedRegistryEntity> = (async (): Promise<VerifiedRegistryEntity> => {
    let value: VerifiedRegistryEntity;
    try {
      if (kind === "npm") {
        value = await this.verifyNpm(name, signal);
      } else if (kind === "pypi") {
        value = await this.verifyPyPi(name, signal);
      } else if (kind === "crates") {
        value = await this.verifyCrates(name, signal);
      } else if (kind === "nuget") {
        value = await this.verifyNuGet(name, signal);
      } else {
        value = await this.verifyGitHub(name, signal);
      }
    } catch (error) {
      // Map transport noise to stable Spanish before caching so error
      // entities never carry raw undici English strings downstream.
      value = {
        kind,
        name,
        status: "error",
        error: WebSearchRegistryVerifier.describeFetchError(error)
      };
      // Caller cancellations are not transient registry failures: caching
      // them would poison the next search with "Operación cancelada…" rows,
      // so the entity is returned uncached and re-verified on the next call.
      if (WebSearchRegistryVerifier.isCallerCancellation(error, signal)) {
        return value;
      }
    }

    const ttlMs: number =
      value.status === "error" ? WebSearchRegistryVerifier.ERROR_CACHE_TTL_MS : this.deps.cacheTtlMs;
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, { value, expiresAtMs: nowMs + ttlMs });
    while (this.cache.size > WebSearchRegistryVerifier.MAX_CACHE_ENTRIES) {
      const oldestKey: string | undefined = this.cache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.cache.delete(oldestKey);
    }
    return value;
    })();

    this.inFlight.set(cacheKey, verification);
    try {
      return await verification;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  }

  /**
   * Reports whether one failure is a caller cancellation.
   *
   * @remarks
   * Internal subfetch timeouts are reclassified as `TimeoutError` upstream
   * and stay cacheable like any transient error; only genuine caller aborts
   * (or errors shaped like one, e.g. a Spanish "cancelada" message) skip
   * the error cache.
   *
   * @param error - Failure from a registry fetch.
   * @param signal - Caller abort signal threaded into the verification.
   * @returns True for caller cancellations.
   */
  private static isCallerCancellation(error: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) {
      return true;
    }
    if (error instanceof Error) {
      if (error.name === "TimeoutError" || /timeout|timed out|ETIMEDOUT/iu.test(error.message)) {
        return false;
      }
      if (error.name === "AbortError" || /abort|cancelad/iu.test(error.message)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Maps transport failures to stable Spanish text.
   *
   * @param error - Failure from a registry fetch.
   * @returns Spanish description for the cached error entity.
   */
  private static describeFetchError(error: unknown): string {
    if (error instanceof Error) {
      const name: string = error.name;
      const message: string = error.message;
      if (name === "TimeoutError" || /timeout|timed out|ETIMEDOUT/iu.test(message)) {
        return "Tiempo de espera agotado al consultar el registro; se reintentará en la próxima búsqueda.";
      }
      if (name === "AbortError" || /abort|cancelad/iu.test(message)) {
        return "Operación cancelada antes de completar la verificación del registro.";
      }
      // Unknown failures (undici transport errors are English by nature,
      // e.g. "fetch failed", "ENOTFOUND", "ECONNRESET") never reach the
      // model raw: they are wrapped in a bounded Spanish note so
      // `verified[].error` stays model-facing Spanish with a short
      // technical tail.
      const bounded: string = sliceUtf8Safe(message.replace(/\s+/gu, " ").trim(), 0, 120);
      return `Fallo de red al consultar el registro (${bounded.length > 0 ? bounded : "sin detalle"}).`;
    }
    const boundedRaw: string = sliceUtf8Safe(String(error).replace(/\s+/gu, " ").trim(), 0, 120);
    return `Fallo de red al consultar el registro (${boundedRaw.length > 0 ? boundedRaw : "sin detalle"}).`;
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
   * @param signal - Optional caller abort signal
   * @returns Verified registry entity
   */
  private async verifyNpm(packageName: string, signal?: AbortSignal): Promise<VerifiedRegistryEntity> {
    const encoded = encodeURIComponent(packageName);
    const sourceUrl = `https://registry.npmjs.org/${encoded}`;
    // Popular packuments (full metadata for thousands of versions) exceed the
    // default 5 MB cap; parity with the EnriCode client plane, which reads
    // the same packument endpoint with a 16 MiB budget.
    const bodyRaw = await this.httpReader.fetchJson(sourceUrl, {
      accept: "application/json",
      signal,
      maxBytes: WebSearchRegistryVerifier.NPM_PACKUMENT_MAX_BYTES
    });
    const body = this.tryGetRecord(bodyRaw.value);
    if (!body) {
      throw new Error(`Respuesta npm inesperada para ${sourceUrl}`);
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
   * @param signal - Optional caller abort signal
   * @returns Verified registry entity
   */
  private async verifyPyPi(projectName: string, signal?: AbortSignal): Promise<VerifiedRegistryEntity> {
    const encoded = encodeURIComponent(projectName);
    const sourceUrl = `https://pypi.org/pypi/${encoded}/json`;
    const bodyRaw = await this.httpReader.fetchJson(sourceUrl, { accept: "application/json", signal });
    const body = this.tryGetRecord(bodyRaw.value);
    if (!body) {
      throw new Error(`Respuesta PyPI inesperada para ${sourceUrl}`);
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
   * @param signal - Optional caller abort signal
   * @returns Verified registry entity
   */
  private async verifyCrates(crateName: string, signal?: AbortSignal): Promise<VerifiedRegistryEntity> {
    const encoded = encodeURIComponent(crateName);
    const sourceUrl = `https://crates.io/api/v1/crates/${encoded}`;
    const bodyRaw = await this.httpReader.fetchJson(sourceUrl, { accept: "application/json", signal });
    const body = this.tryGetRecord(bodyRaw.value);
    if (!body) {
      throw new Error(`Respuesta crates.io inesperada para ${sourceUrl}`);
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
   * @param signal - Optional caller abort signal
   * @returns Verified registry entity
   */
  private async verifyNuGet(packageId: string, signal?: AbortSignal): Promise<VerifiedRegistryEntity> {
    const lowerId = packageId.toLowerCase();
    const serviceIndex = await this.getNuGetServiceIndex(signal);

    if (!serviceIndex.packageBaseAddressUrl) {
      return {
        kind: "nuget",
        name: packageId,
        status: "error",
        error: "El índice de NuGet no proporcionó PackageBaseAddress."
      };
    }

    const versionsUrl = `${serviceIndex.packageBaseAddressUrl}${lowerId}/index.json`;
    const versionsBodyRaw = await this.httpReader.fetchJson(versionsUrl, { accept: "application/json", signal });
    const versionsBody = this.tryGetRecord(versionsBodyRaw.value);
    if (!versionsBody) {
      throw new Error(`Respuesta NuGet inesperada para ${versionsUrl}`);
    }
    const versions = Array.isArray(versionsBody["versions"]) ? versionsBody["versions"] : [];
    const versionStrings = versions
      .map((v) => (typeof v === "string" ? v : null))
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);

    const bestStable = this.pickBestSemVer(versionStrings, { prerelease: false });
    const bestPre = this.pickBestSemVer(versionStrings, { prerelease: true });

    const stablePublishedAt =
      bestStable && serviceIndex.registrationsBaseUrl
        ? await this.tryFetchNuGetLeafPublishedAt(serviceIndex.registrationsBaseUrl, lowerId, bestStable, signal)
        : null;
    const prePublishedAt =
      bestPre && serviceIndex.registrationsBaseUrl
        ? await this.tryFetchNuGetLeafPublishedAt(serviceIndex.registrationsBaseUrl, lowerId, bestPre, signal)
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
   * @remarks
   * `latest_stable` comes from `/releases/latest` (GitHub's own newest
   * non-prerelease, non-draft pick, immune to first-page truncation);
   * prerelease candidates page through `/releases?per_page=100` following
   * the `Link` header (up to {@link GITHUB_RELEASES_MAX_PAGES} pages, i.e.
   * 300 newest releases — beyond that the first pages are what we keep).
   *
   * @param repoSlug - Repository slug in the form "owner/repo"
   * @param signal - Optional caller abort signal
   * @returns Verified registry entity
   */
  private async verifyGitHub(repoSlug: string, signal?: AbortSignal): Promise<VerifiedRegistryEntity> {
    const cleanSlug: string = repoSlug.trim().replace(/\.git$/iu, "");
    const parts = cleanSlug.split("/");
    const owner = parts[0];
    const repo = parts[1];
    if (!owner || !repo) {
      return { kind: "github", name: repoSlug, status: "error", error: "Repositorio inválido." };
    }

    const latestUrl = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const listUrl = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`;

    let latestStable: { version: string; publishedAt: string | null } | null = null;
    try {
      const latestPage = await this.httpReader.fetchJson(latestUrl, {
        accept: "application/vnd.github+json",
        githubToken: this.deps.githubToken,
        signal
      });
      const latest = this.tryParseGitHubReleaseCandidate(latestPage.value);
      if (latest !== null && !latest.prerelease) {
        latestStable = { version: latest.version, publishedAt: latest.publishedAt };
      }
    } catch (error) {
      // /releases/latest 404s when the repo has no published stable release
      // at all; any other failure fails the entity honestly.
      const message: string = error instanceof Error ? error.message : String(error);
      if (!/HTTP 404/u.test(message)) {
        throw error;
      }
    }

    const stableListFallbacks: Array<{ version: string; publishedAt: string | null; prerelease: boolean }> = [];
    const preCandidates: Array<{ version: string; publishedAt: string | null; prerelease: boolean }> = [];

    let nextUrl: string | null = listUrl;
    let fetchedPages = 0;
    while (nextUrl !== null && fetchedPages < WebSearchRegistryVerifier.GITHUB_RELEASES_MAX_PAGES) {
      const page = await this.httpReader.fetchJson(nextUrl, {
        accept: "application/vnd.github+json",
        githubToken: this.deps.githubToken,
        signal
      });
      fetchedPages += 1;
      const releases: unknown[] = Array.isArray(page.value) ? page.value : [];
      for (const item of releases) {
        const candidate = this.tryParseGitHubReleaseCandidate(item);
        if (candidate === null) {
          continue;
        }
        if (candidate.prerelease) {
          preCandidates.push(candidate);
        } else {
          stableListFallbacks.push(candidate);
        }
      }
      nextUrl = page.nextUrl;
    }

    const bestStable =
      latestStable ?? this.pickBestVersionCandidate(stableListFallbacks, { prerelease: false });
    const bestPre = this.pickBestVersionCandidate(preCandidates, { prerelease: true });

    return {
      kind: "github",
      name: repoSlug,
      latest_stable: bestStable
        ? {
            version: bestStable.version,
            published_at: bestStable.publishedAt ?? undefined,
            // Provenance honesty: attribute the fallback pick to the list
            // endpoint it actually came from, not to /releases/latest.
            source_url: latestStable !== null ? latestUrl : listUrl
          }
        : undefined,
      latest_prerelease: bestPre
        ? { version: bestPre.version, published_at: bestPre.publishedAt ?? undefined, source_url: listUrl }
        : undefined,
      status: "ok"
    };
  }

  /**
   * Parses one GitHub release entry into a version candidate.
   *
   * @param raw - Release entry from the GitHub API
   * @returns Candidate, or null for drafts/entries without a tag
   */
  private tryParseGitHubReleaseCandidate(
    raw: unknown
  ): { version: string; publishedAt: string | null; prerelease: boolean } | null {
    const record = this.tryGetRecord(raw);
    if (!record) {
      return null;
    }
    if (record["draft"] === true) {
      return null;
    }
    const tagNameRaw = this.tryGetNonEmptyString(record["tag_name"]);
    if (!tagNameRaw) {
      return null;
    }
    const tagName = tagNameRaw.startsWith("v") ? tagNameRaw.slice(1) : tagNameRaw;
    return {
      version: tagName,
      publishedAt: this.tryGetNonEmptyString(record["published_at"]),
      prerelease: record["prerelease"] === true
    };
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
    if (segments.length < 2 || segments[0] !== "package") {
      return null;
    }

    const first = segments[1];
    if (!first) {
      return null;
    }

    if (first.startsWith("@") && first.includes("/")) {
      const [scope, name] = first.split("/");
      if (!scope || !name) {
        return null;
      }
      return `${scope}/${name}`;
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
    const repoRaw = segments[1];
    if (!owner || !repoRaw) {
      return null;
    }
    const repo: string = repoRaw.replace(/\.git$/iu, "");

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
   * @remarks
   * Covers PEP 440 separators and attached suffixes (`1.0b1`, `2.0beta1`)
   * where the marker follows digits without a delimiter.
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
    if (/\d(?:a|b|rc|dev|alpha|beta|pre|preview)\d*/.test(lower)) {
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
      const itemTime: number | null = this.tryParseTimeMs(item.publishedAt);
      const bestTime: number | null =
        bestByTime !== undefined ? this.tryParseTimeMs(bestByTime.publishedAt) : null;
      if (itemTime !== null && (bestTime === null || itemTime > bestTime)) {
        bestByTime = item;
      }
    }
    return bestByTime;
  }

  /**
   * Parses one ISO timestamp to epoch milliseconds.
   *
   * @param value - Timestamp string, if present.
   * @returns Epoch milliseconds, or null when missing or unparsable.
   */
  private tryParseTimeMs(value: string | null): number | null {
    if (value === null || !value.trim()) {
      return null;
    }
    const parsed: number = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  /**
   * Parses SemVer strings (best-effort).
   *
   * @remarks
   * Accepts two to four numeric components (`1.2` → `1.2.0`, `1.2.3.4`
   * keeps the fourth as a build tiebreak) so partial registry versions
   * still rank instead of dropping out.
   *
   * @param raw - Version string
   * @returns Parsed semver or null
   */
  private tryParseSemVer(raw: string): SemVerParsed | null {
    const trimmed = raw.trim();
    const normalized = trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
    const match =
      /^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        normalized
      );
    if (!match) {
      return this.tryParseAttachedPrerelease(normalized);
    }
    const major = Number.parseInt(match[1] ?? "", 10);
    const minor = Number.parseInt(match[2] ?? "", 10);
    const patch = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
    const build = match[4] === undefined ? 0 : Number.parseInt(match[4], 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch) || !Number.isFinite(build)) {
      return null;
    }
    const prereleaseRaw = match[5];
    const prerelease = prereleaseRaw
      ? prereleaseRaw.split(".").filter((p) => p.length > 0)
      : [];

    return { raw: normalized, major, minor, patch, build, prerelease };
  }

  /**
   * Parses versions with attached prerelease suffixes (`2024.1b1`, `2.0rc2`).
   *
   * @param normalized - Version string without a leading "v".
   * @returns Parsed semver or null.
   */
  private tryParseAttachedPrerelease(normalized: string): SemVerParsed | null {
    const match =
      /^(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?(a|b|rc|alpha|beta|pre|preview|dev)(\d*)$/i.exec(
        normalized
      );
    if (!match) {
      return null;
    }
    const major = Number.parseInt(match[1] ?? "", 10);
    const minor = Number.parseInt(match[2] ?? "", 10);
    const patch = match[3] === undefined ? 0 : Number.parseInt(match[3], 10);
    const build = match[4] === undefined ? 0 : Number.parseInt(match[4], 10);
    if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch) || !Number.isFinite(build)) {
      return null;
    }
    const marker: string = (match[5] ?? "").toLowerCase();
    const number: string = match[6] ?? "";
    return {
      raw: normalized,
      major,
      minor,
      patch,
      build,
      prerelease: [number ? `${marker}.${number}` : marker]
    };
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
    if (a.build !== b.build) {
      return a.build - b.build;
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
    let bestMs = -1;
    for (const item of releaseFiles) {
      const record = this.tryGetRecord(item);
      if (!record) {
        continue;
      }
      const uploadTime = this.tryGetNonEmptyString(record["upload_time_iso_8601"]);
      if (!uploadTime) {
        continue;
      }
      const uploadMs: number | null = this.tryParseTimeMs(uploadTime);
      if (uploadMs === null) {
        continue;
      }
      if (best === null || uploadMs > bestMs) {
        best = uploadTime;
        bestMs = uploadMs;
      }
    }
    return best;
  }

  /**
   * Resolves NuGet V3 endpoints from the service index, with caching.
   *
   * @param signal - Optional caller abort signal
   * @returns Service index cache
   */
  private async getNuGetServiceIndex(signal?: AbortSignal): Promise<NuGetServiceIndexCache> {
    const nowMs = Date.now();
    if (this.nugetServiceIndexCache && this.nugetServiceIndexCache.expiresAtMs > nowMs) {
      return this.nugetServiceIndexCache;
    }

    const bodyRaw = await this.httpReader.fetchJson(WebSearchRegistryVerifier.NUGET_SERVICE_INDEX_URL, {
      accept: "application/json",
      signal
    });
    const body = this.tryGetRecord(bodyRaw.value);
    if (!body) {
      throw new Error("Respuesta inesperada del índice de NuGet.");
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
   * @param signal - Optional caller abort signal
   * @returns Published ISO 8601 timestamp or null
   */
  private async tryFetchNuGetLeafPublishedAt(
    registrationsBaseUrl: string,
    lowerId: string,
    version: string,
    signal?: AbortSignal
  ): Promise<string | null> {
    const leafUrl = `${registrationsBaseUrl}${lowerId}/${encodeURIComponent(version)}.json`;
    try {
      const bodyRaw = await this.httpReader.fetchJson(leafUrl, { accept: "application/json", signal });
      const body = this.tryGetRecord(bodyRaw.value);
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
