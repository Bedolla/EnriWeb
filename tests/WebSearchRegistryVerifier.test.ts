import { describe, expect, it } from "vitest";

import type { WebSearchResultEntry } from "../src/client/EnriProxyClient.js";
import { WebSearchRegistryVerifier } from "../src/tools/WebSearchRegistryVerifier.js";

const createJsonResponse = (data: unknown): Response => {
  return {
    ok: true,
    status: 200,
    json: async () => data
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
});

