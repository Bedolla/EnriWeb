import { describe, expect, it } from "vitest";

import type { EnriProxyClient, WebSearchResponse } from "../src/client/EnriProxyClient.js";
import { WebSearchTool } from "../src/tools/WebSearchTool.js";
import type { WebSearchRegistryVerifier } from "../src/tools/WebSearchRegistryVerifier.js";

const createRegistryVerifierStub = (): WebSearchRegistryVerifier => {
  return {
    verifyFromSearchResults: async () => {
      return [];
    }
  } as unknown as WebSearchRegistryVerifier;
};

describe("WebSearchTool.parseParams", () => {
  it("rejects missing query", () => {
    const tool = new WebSearchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    expect(() => tool.parseParams({})).toThrow(/query/i);
  });

  it("maps snake_case fields to params", () => {
    const tool = new WebSearchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    const params = tool.parseParams({
      query: "typescript best practices",
      max_results: "7",
      recency: "oneMonth",
      allowed_domains: ["developer.mozilla.org", "www.typescriptlang.org"],
      blocked_domains: ["example.com"],
      search_prompt: "docs only"
    });

    expect(params.query).toBe("typescript best practices");
    expect(params.maxResults).toBe(7);
    expect(params.recency).toBe("oneMonth");
    expect(params.allowedDomains?.length).toBe(2);
    expect(params.blockedDomains?.length).toBe(1);
    expect(params.searchPrompt).toBe("docs only");
  });

  it("rejects invalid recency values", () => {
    const tool = new WebSearchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    expect(() => tool.parseParams({ query: "test", recency: "yesterday" })).toThrow(/recency/i);
  });

  it("rejects invalid max_results", () => {
    const tool = new WebSearchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    expect(tool.parseParams({ query: "test", max_results: 0 }).maxResults).toBeUndefined();
    expect(tool.parseParams({ query: "test", max_results: -5 }).maxResults).toBeUndefined();
    expect(tool.parseParams({ query: "test", max_results: 30 }).maxResults).toBe(30);
  });

  it("aligns the queries contract with EnriProxy (empty array falls back, bad containers fail)", () => {
    const tool = new WebSearchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    const params = tool.parseParams({
      queries: ["bun sqlite windows", "bun sqlite windows", "bun:sqlite platform support"]
    });
    expect(params.queries).toEqual(["bun sqlite windows", "bun:sqlite platform support"]);
    expect(params.query).toBe("bun sqlite windows");

    // Proxy parity: an empty queries array is treated as absent, so the
    // plain query drives the search instead of failing the call.
    const fallback = tool.parseParams({ query: "single query", queries: [] });
    expect(fallback.queries).toBeUndefined();
    expect(fallback.query).toBe("single query");
    expect(() => tool.parseParams({ queries: [] })).toThrow(/query|queries/i);

    expect(() => tool.parseParams({ queries: ["a", " "] })).toThrow(/queries/i);
    expect(() => tool.parseParams({ queries: ["1", "2", "3", "4", "5"] })).toThrow(/queries/i);
    expect(() => tool.parseParams({ queries: "single" })).toThrow(/arreglo de strings/i);
    expect(() => tool.parseParams({ queries: null })).toThrow(/arreglo de strings/i);
    expect(() => tool.parseParams({ query: "q", queries: 42 })).toThrow(/arreglo de strings/i);
  });
});

describe("WebSearchTool.formatOutput", () => {
  const tool = new WebSearchTool({
    createClient: () => {
      throw new Error("not used");
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    registryVerifier: createRegistryVerifierStub()
  });

  it("appends the untrusted-content notice and citation instruction to single-query results", () => {
    const output = tool.formatOutput({
      query: "rust async",
      queries: ["rust async"],
      results: [
        {
          url: "https://example.com/rust",
          title: "Rust async book",
          snippet: "Async in Rust"
        }
      ],
      count: 1
    });

    expect(output).toContain("RESULTADOS DE BÚSQUEDA (1 encontrado):");
    expect(output).toContain("contenido externo no confiable");
    expect(output).toContain("cite las URLs relevantes");
    expect(output).not.toContain("consultas combinadas");
  });

  it("renders batched headers, executed queries, and partial failures", () => {
    const output = tool.formatOutput({
      query: "q1",
      queries: ["q1", "q2"],
      results: [
        { url: "https://example.com/a", title: "A", snippet: "sa" },
        { url: "https://example.com/b", title: "B", snippet: "sb" }
      ],
      count: 2,
      failedQueries: ["q3"]
    });

    expect(output).toContain("2 consultas combinadas y deduplicadas por URL");
    expect(output).toContain('Consultas ejecutadas: "q1", "q2"');
    expect(output).toContain('Consultas que fallaron');
    expect(output).toContain('"q3"');
    expect(output).toContain("contenido externo no confiable");
  });

  it("renders the engine-outage row when the server reports unresponsive engines", () => {
    const output = tool.formatOutput({
      query: "q1",
      queries: ["q1"],
      results: [{ url: "https://example.com/a", title: "A", snippet: "sa" }],
      count: 1,
      unresponsiveEngines: ["google: timeout", "bing: timeout"]
    });

    expect(output).toContain("Motores sin respuesta en esta búsqueda: google: timeout, bing: timeout.");
  });

  it("caps fetched contents and renders the verified section", () => {
    const tool = new WebSearchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    const output = tool.formatOutput({
      query: "q",
      queries: ["q"],
      results: [{ url: "https://example.com/a", title: "A", snippet: "sa" }],
      count: 1,
      fetchedContents: [
        { url: "https://example.com/a", title: "A", content: "x".repeat(20000), truncated: true }
      ],
      verified: [
        {
          kind: "npm",
          name: "chalk",
          latest_stable: { version: "5.6.2", source_url: "https://registry.npmjs.org/chalk" },
          status: "ok"
        }
      ]
    });

    expect(output).toContain("VERIFICACIÓN DE REGISTROS");
    expect(output).toContain("npm:chalk: estable 5.6.2");
    expect(output).toContain("[recortado]");
  });

  it("caps long result lists and renders per-query attribution", async () => {
    const tool = new WebSearchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    const output = tool.formatOutput({
      query: "q1",
      queries: ["q1", "q2"],
      results: Array.from({ length: 12 }, (_v, index) => ({
        url: `https://example.com/${String(index)}`,
        title: `T${String(index)}`,
        snippet: `s${String(index)}`
      })),
      count: 12,
      perQuery: [
        { query: "q1", urls: ["https://example.com/0"] },
        { query: "q2", urls: ["https://example.com/1"] }
      ]
    });

    expect(output).toContain("…y 2 resultados más (ver structuredContent.results).");
    expect(output).toContain("Atribución por consulta:");
    expect(output).toContain('"q1": https://example.com/0');
  });
});

describe("WebSearchTool.execute", () => {
  it("passes per_query groups and fetched_count through to the caller", async () => {
    const tool = new WebSearchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webSearch"> = {
          webSearch: async (): Promise<WebSearchResponse> => ({
            results: [{ url: "https://example.com/a", title: "A", snippet: "sa" }],
            count: 1,
            queries: ["q1", "q2"],
            per_query: [
              { query: "q1", urls: ["https://example.com/a"] },
              { query: "q2", urls: [] }
            ],
            fetched_contents: [],
            fetched_count: 0
          })
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: createRegistryVerifierStub()
    });

    const result = await tool.execute({ query: "q1", queries: ["q1", "q2"] });

    expect(result.perQuery).toEqual([
      { query: "q1", urls: ["https://example.com/a"] },
      { query: "q2", urls: [] }
    ]);
    expect(result.fetchedCount).toBe(0);
  });
});
