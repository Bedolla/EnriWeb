import { describe, expect, it } from "vitest";

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

    expect(() => tool.parseParams({ query: "test", max_results: 0 })).toThrow(/max_results/i);
    expect(() => tool.parseParams({ query: "test", max_results: -5 })).toThrow(/max_results/i);
    expect(tool.parseParams({ query: "test", max_results: 30 }).maxResults).toBe(30);
  });

  it("accepts batched queries with dedupe and bounds", () => {
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

    expect(() => tool.parseParams({ queries: [] })).toThrow(/queries/i);
    expect(() => tool.parseParams({ queries: ["a", " "] })).toThrow(/queries/i);
    expect(() =>
      tool.parseParams({ queries: ["1", "2", "3", "4", "5"] })
    ).toThrow(/queries/i);
    expect(() => tool.parseParams({ queries: "single" })).toThrow(/queries/i);
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

    expect(output).toContain("RESULTADOS DE BÚSQUEDA (1 encontrados)");
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
});
