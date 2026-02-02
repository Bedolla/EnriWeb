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
});
