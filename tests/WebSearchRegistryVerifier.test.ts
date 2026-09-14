import { describe, expect, it } from "vitest";

import type { WebSearchResultEntry } from "../src/client/EnriProxyClient.js";
import { WebSearchRegistryVerifier } from "../src/tools/WebSearchRegistryVerifier.js";

const createJsonResponse = (data: unknown): Response => {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (_name: string): string | null => null
    },
    json: async () => data,
    text: async () => JSON.stringify(data)
  } as unknown as Response;
};

/**
 * Creates a JSON response carrying a Link header for pagination tests.
 *
 * @param data - JSON payload
 * @param link - Raw Link header value, or null
 * @returns Fake Response
 */
const createJsonResponseWithLink = (data: unknown, link: string | null): Response => {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string): string | null => (name.toLowerCase() === "link" ? link : null)
    },
    json: async () => data,
    text: async () => JSON.stringify(data)
  } as unknown as Response;
};

/**
 * Creates a non-ok JSON response.
 *
 * @param status - HTTP status to report
 * @returns Fake Response
 */
const createErrorResponse = (status: number): Response => {
  return {
    ok: false,
    status,
    headers: {
      get: (_name: string): string | null => null
    },
    json: async () => ({}),
    text: async () => "{}"
  } as unknown as Response;
};

describe("WebSearchRegistryVerifier", () => {
  it("enriches npm results with latest stable + prerelease", async () => {
    const results: WebSearchResultEntry[] = [
      {
        url: "https://www.npmjs.com/package/nuxt",
        title: "nuxt - npm",
        snippet: "Nuxt is a framework..."
      }
    ];

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === "https://registry.npmjs.org/nuxt") {
        return createJsonResponse({
          "dist-tags": { latest: "4.1.2" },
          versions: { "4.1.2": {}, "4.2.0-rc.1": {}, "3.0.0": {} },
          time: {
            "4.1.2": "2026-01-12T00:00:00.000Z",
            "4.2.0-rc.1": "2026-01-13T00:00:00.000Z"
          }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults(results);
    expect(verified.length).toBe(1);
    expect(verified[0]?.kind).toBe("npm");
    expect(verified[0]?.name).toBe("nuxt");
    expect(verified[0]?.latest_stable?.version).toBe("4.1.2");
    expect(verified[0]?.latest_prerelease?.version).toBe("4.2.0-rc.1");
  });

  it("enriches NuGet results with latest stable + prerelease", async () => {
    const results: WebSearchResultEntry[] = [
      {
        url: "https://www.nuget.org/packages/Newtonsoft.Json/",
        title: "Newtonsoft.Json",
        snippet: "JSON framework for .NET"
      }
    ];

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === "https://api.nuget.org/v3/index.json") {
        return createJsonResponse({
          resources: [
            {
              "@id": "https://api.nuget.org/v3-flatcontainer/",
              "@type": "PackageBaseAddress/3.0.0"
            },
            {
              "@id": "https://api.nuget.org/v3/registration5-semver1/",
              "@type": "RegistrationsBaseUrl/3.6.0"
            }
          ]
        });
      }

      if (url === "https://api.nuget.org/v3-flatcontainer/newtonsoft.json/index.json") {
        return createJsonResponse({
          versions: ["1.0.0", "1.0.1-beta.1", "2.0.0"]
        });
      }

      if (
        url ===
        "https://api.nuget.org/v3/registration5-semver1/newtonsoft.json/2.0.0.json"
      ) {
        return createJsonResponse({
          catalogEntry: { published: "2026-01-10T00:00:00Z" }
        });
      }

      if (
        url ===
        "https://api.nuget.org/v3/registration5-semver1/newtonsoft.json/1.0.1-beta.1.json"
      ) {
        return createJsonResponse({
          catalogEntry: { published: "2026-01-11T00:00:00Z" }
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults(results);
    expect(verified.length).toBe(1);
    expect(verified[0]?.kind).toBe("nuget");
    expect(verified[0]?.name).toBe("Newtonsoft.Json");
    expect(verified[0]?.latest_stable?.version).toBe("2.0.0");
    expect(verified[0]?.latest_prerelease?.version).toBe("1.0.1-beta.1");
    expect(verified[0]?.latest_stable?.published_at).toBe("2026-01-10T00:00:00Z");
    expect(verified[0]?.latest_prerelease?.published_at).toBe(
      "2026-01-11T00:00:00Z"
    );
  });

  it("ranks partial versions and caches failures briefly", async () => {
    const results: WebSearchResultEntry[] = [
      {
        url: "https://www.npmjs.com/package/widget",
        title: "widget - npm",
        snippet: "A widget"
      },
      {
        url: "https://www.npmjs.com/package/broken",
        title: "broken - npm",
        snippet: "Always fails"
      }
    ];

    let fetchCount = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      fetchCount += 1;
      if (url === "https://registry.npmjs.org/widget") {
        return createJsonResponse({
          "dist-tags": {},
          versions: { "2024.1": {}, "2023.9": {}, "2024.1b1": {} },
          time: {}
        });
      }
      throw new Error("registry down");
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const first = await verifier.verifyFromSearchResults(results);
    const widget = first.find((entry) => entry.name === "widget");
    expect(widget?.latest_stable?.version).toBe("2024.1");
    expect(widget?.latest_prerelease?.version).toBe("2024.1b1");
    expect(first.find((entry) => entry.name === "broken")?.status).toBe("error");

    const countAfterFirst = fetchCount;
    await verifier.verifyFromSearchResults(results);
    expect(fetchCount).toBe(countAfterFirst);
  });

  it("degrades to an error entity instead of failing when aborted mid-flight", async () => {
    const controller = new AbortController();
    const results: WebSearchResultEntry[] = [
      {
        url: "https://www.npmjs.com/package/slow",
        title: "slow - npm",
        snippet: "Slow registry"
      }
    ];

    const fetchImpl = async (): Promise<Response> => {
      controller.abort();
      throw new DOMException("Aborted", "AbortError");
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults(results, controller.signal);
    expect(verified.length).toBe(1);
    expect(verified[0]?.status).toBe("error");
  });

  it("reports oversized registry payloads in Spanish instead of parsing them", async () => {
    const results: WebSearchResultEntry[] = [
      {
        url: "https://www.npmjs.com/package/huge",
        title: "huge - npm",
        snippet: "Huge package"
      }
    ];

    const fetchImpl = async (): Promise<Response> => {
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string): string | null =>
            name.toLowerCase() === "content-length" ? "99999999" : "application/json"
        },
        json: async () => ({}),
        text: async () => "{}"
      } as unknown as Response;
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults(results);
    expect(verified.length).toBe(1);
    expect(verified[0]?.status).toBe("error");
    expect(verified[0]?.error).toContain("excede el máximo");
  });

  it("returns no verifications when the caller signal is already aborted", async () => {
    let calls = 0;
    const fetchImpl = async (): Promise<Response> => {
      calls += 1;
      return createJsonResponse({});
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const controller = new AbortController();
    controller.abort();
    const verified = await verifier.verifyFromSearchResults(
      [{ url: "https://www.npmjs.com/package/nuxt", title: "nuxt", snippet: "s" }],
      controller.signal
    );
    expect(verified).toEqual([]);
    expect(calls).toBe(0);
  });

  it("resolves github latest_stable from /releases/latest and pages prereleases via Link", async () => {
    const requested: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      requested.push(url);
      if (url === "https://api.github.com/repos/owner/repo/releases/latest") {
        return createJsonResponse({
          tag_name: "v2.0.0",
          published_at: "2026-02-01T00:00:00Z",
          prerelease: false
        });
      }
      if (url === "https://api.github.com/repos/owner/repo/releases?per_page=100") {
        return createJsonResponseWithLink(
          [
            { tag_name: "v1.9.0", prerelease: false, published_at: "2026-01-01T00:00:00Z" },
            { tag_name: "v2.1.0-rc.1", prerelease: true, published_at: "2026-02-10T00:00:00Z" }
          ],
          '<https://api.github.com/repos/owner/repo/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/owner/repo/releases?per_page=100&page=5>; rel="last"'
        );
      }
      if (url === "https://api.github.com/repos/owner/repo/releases?per_page=100&page=2") {
        return createJsonResponseWithLink(
          [{ tag_name: "v2.2.0-beta.3", prerelease: true, published_at: "2026-02-15T00:00:00Z" }],
          null
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults([
      { url: "https://github.com/owner/repo", title: "repo", snippet: "s" }
    ]);

    expect(verified.length).toBe(1);
    expect(verified[0]?.kind).toBe("github");
    expect(verified[0]?.latest_stable?.version).toBe("2.0.0");
    expect(verified[0]?.latest_stable?.published_at).toBe("2026-02-01T00:00:00Z");
    expect(verified[0]?.latest_stable?.source_url).toBe(
      "https://api.github.com/repos/owner/repo/releases/latest"
    );
    // The prerelease winner lives on page 2, only reachable via the Link header.
    expect(verified[0]?.latest_prerelease?.version).toBe("2.2.0-beta.3");
    expect(requested).toContain("https://api.github.com/repos/owner/repo/releases?per_page=100&page=2");
  });

  it("keeps the first releases page when GitHub sends no Link header", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === "https://api.github.com/repos/owner/repo/releases/latest") {
        return createJsonResponse({ tag_name: "3.1.0", prerelease: false });
      }
      if (url === "https://api.github.com/repos/owner/repo/releases?per_page=100") {
        return createJsonResponseWithLink(
          [
            { tag_name: "v3.1.0", prerelease: false },
            { tag_name: "v3.2.0-alpha.1", prerelease: true }
          ],
          null
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults([
      { url: "https://github.com/owner/repo", title: "repo", snippet: "s" }
    ]);

    expect(verified[0]?.latest_stable?.version).toBe("3.1.0");
    expect(verified[0]?.latest_prerelease?.version).toBe("3.2.0-alpha.1");
  });

  it("reports no stable version when /releases/latest answers 404", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === "https://api.github.com/repos/owner/repo/releases/latest") {
        return createErrorResponse(404);
      }
      if (url === "https://api.github.com/repos/owner/repo/releases?per_page=100") {
        return createJsonResponseWithLink([{ tag_name: "v0.1.0-rc.1", prerelease: true }], null);
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults([
      { url: "https://github.com/owner/repo", title: "repo", snippet: "s" }
    ]);

    expect(verified[0]?.status).toBe("ok");
    expect(verified[0]?.latest_stable).toBeUndefined();
    expect(verified[0]?.latest_prerelease?.version).toBe("0.1.0-rc.1");
  });

  it("maps undici timeouts and aborts to Spanish before caching error entities", async () => {
    const cases: Array<{ error: unknown; expected: RegExp }> = [
      { error: new DOMException("The operation timed out", "TimeoutError"), expected: /Tiempo de espera agotado/i },
      {
        error: new Error("fetch failed: this operation was aborted due to timeout"),
        expected: /Tiempo de espera agotado/i
      },
      { error: new DOMException("This operation was aborted", "AbortError"), expected: /Operación cancelada/i }
    ];

    for (const testCase of cases) {
      const fetchImpl = async (): Promise<Response> => {
        throw testCase.error;
      };
      const verifier = new WebSearchRegistryVerifier({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        timeoutMs: 5000,
        cacheTtlMs: 60_000,
        maxEntitiesPerCall: 5
      });

      const verified = await verifier.verifyFromSearchResults([
        { url: "https://www.npmjs.com/package/slow", title: "slow", snippet: "s" }
      ]);
      expect(verified[0]?.status).toBe("error");
      expect(verified[0]?.error).toMatch(testCase.expected);
    }
  });

  it("skips the error cache for caller cancellations so the next search re-verifies", async () => {
    let fetchCount = 0;
    const firstController = new AbortController();
    const fetchImpl = async (): Promise<Response> => {
      fetchCount += 1;
      if (fetchCount === 1) {
        firstController.abort();
        throw new DOMException("Aborted", "AbortError");
      }
      return createJsonResponse({
        "dist-tags": { latest: "1.2.3" },
        versions: { "1.2.3": {} },
        time: {}
      });
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const npmEntry: WebSearchResultEntry = {
      url: "https://www.npmjs.com/package/slow",
      title: "slow",
      snippet: "s"
    };

    const first = await verifier.verifyFromSearchResults([npmEntry], firstController.signal);
    expect(first[0]?.status).toBe("error");
    expect(first[0]?.error).toMatch(/cancelada/iu);

    // The cancellation must not be cached: the next search re-verifies the
    // entity instead of replaying "Operación cancelada…".
    const second = await verifier.verifyFromSearchResults([npmEntry]);
    expect(fetchCount).toBe(2);
    expect(second[0]?.status).toBe("ok");
    expect(second[0]?.latest_stable?.version).toBe("1.2.3");
  });

  it("attributes the fallback stable pick to the releases list endpoint", async () => {
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === "https://api.github.com/repos/owner/repo/releases/latest") {
        return createErrorResponse(404);
      }
      if (url === "https://api.github.com/repos/owner/repo/releases?per_page=100") {
        return createJsonResponseWithLink(
          [
            { tag_name: "v1.5.0", prerelease: false, published_at: "2026-01-05T00:00:00Z" },
            { tag_name: "v1.6.0-rc.1", prerelease: true, published_at: "2026-02-05T00:00:00Z" }
          ],
          null
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const verified = await verifier.verifyFromSearchResults([
      { url: "https://github.com/owner/repo", title: "repo", snippet: "s" }
    ]);

    expect(verified[0]?.latest_stable?.version).toBe("1.5.0");
    expect(verified[0]?.latest_stable?.source_url).toBe(
      "https://api.github.com/repos/owner/repo/releases?per_page=100"
    );
    expect(verified[0]?.latest_prerelease?.source_url).toBe(
      "https://api.github.com/repos/owner/repo/releases?per_page=100"
    );
  });

  it("evicts by real LRU: a hit refreshes recency so the oldest cold entry is evicted first", async () => {
    const fetchCount: Map<string, number> = new Map<string, number>();
    const fetchImpl = async (url: string): Promise<Response> => {
      const match: RegExpExecArray | null = /^https:\/\/registry\.npmjs\.org\/pack-(\d+)$/u.exec(url);
      if (match !== null) {
        fetchCount.set(url, (fetchCount.get(url) ?? 0) + 1);
        return createJsonResponse({
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": {} },
          time: { "1.0.0": "2026-01-01T00:00:00.000Z" }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const entryFor = (index: number): WebSearchResultEntry => ({
      url: `https://www.npmjs.com/package/pack-${String(index)}`,
      title: `pack-${String(index)}`,
      snippet: "s"
    });

    // Fill the cache to its 200-entry ceiling in batches of 5.
    for (let batch = 0; batch < 40; batch += 1) {
      const entries: WebSearchResultEntry[] = [];
      for (let i = 0; i < 5; i += 1) {
        entries.push(entryFor(batch * 5 + i + 1));
      }
      await verifier.verifyFromSearchResults(entries);
    }
    expect(fetchCount.size).toBe(200);

    // Refresh the oldest entry (pack-1) so it becomes most-recently-used.
    await verifier.verifyFromSearchResults([entryFor(1)]);
    expect(fetchCount.get("https://registry.npmjs.org/pack-1")).toBe(1);

    // Inserting one more entry evicts the least-recently-used COLD entry
    // (pack-2), not the hot pack-1.
    await verifier.verifyFromSearchResults([entryFor(201)]);

    const hotAgain = await verifier.verifyFromSearchResults([entryFor(1)]);
    expect(hotAgain.length).toBe(1);
    expect(fetchCount.get("https://registry.npmjs.org/pack-1")).toBe(1); // cache hit, no refetch

    const evicted = await verifier.verifyFromSearchResults([entryFor(2)]);
    expect(evicted.length).toBe(1);
    expect(fetchCount.get("https://registry.npmjs.org/pack-2")).toBe(2); // evicted, refetched
  });

  it("coalesces concurrent verifications of the same entity into one registry fetch", async () => {
    let fetches: number = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url === "https://registry.npmjs.org/single-flight") {
        fetches += 1;
        await new Promise((resolve: () => void): void => {
          setTimeout(resolve, 25);
        });
        return createJsonResponse({
          "dist-tags": { latest: "2.0.0" },
          versions: { "2.0.0": {} },
          time: { "2.0.0": "2026-01-01T00:00:00.000Z" }
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const verifier = new WebSearchRegistryVerifier({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 5000,
      cacheTtlMs: 60_000,
      maxEntitiesPerCall: 5
    });

    const entry: WebSearchResultEntry = {
      url: "https://www.npmjs.com/package/single-flight",
      title: "single-flight",
      snippet: "s"
    };
    const [first, second] = await Promise.all([
      verifier.verifyFromSearchResults([entry]),
      verifier.verifyFromSearchResults([entry])
    ]);

    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(fetches).toBe(1);
  });
});

