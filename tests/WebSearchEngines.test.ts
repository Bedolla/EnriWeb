import { describe, expect, it } from "vitest";

import type {
  EnriProxyClient,
  WebSearchRequest,
  WebSearchResponse
} from "../src/client/EnriProxyClient.js";
import { parseSearchEnginesEnv } from "../src/shared/operatorSearchEngines.js";
import { WebSearchTool } from "../src/tools/WebSearchTool.js";
import type { WebSearchRegistryVerifier } from "../src/tools/WebSearchRegistryVerifier.js";

const createRegistryVerifierStub = (): WebSearchRegistryVerifier => {
  return {
    verifyFromSearchResults: async () => {
      return [];
    }
  } as unknown as WebSearchRegistryVerifier;
};

function makeTool(
  handler: (params: WebSearchRequest) => Promise<WebSearchResponse>,
  calls: WebSearchRequest[],
  defaultEngines?: string
): WebSearchTool {
  return new WebSearchTool({
    createClient: () => {
      const fake: Pick<EnriProxyClient, "webSearch"> = {
        webSearch: async (params: WebSearchRequest): Promise<WebSearchResponse> => {
          calls.push(params);
          return handler(params);
        }
      };
      return fake as EnriProxyClient;
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    defaultEngines,
    registryVerifier: createRegistryVerifierStub()
  });
}

describe("parseSearchEnginesEnv", () => {
  it("accepts engine lists and trims them", () => {
    expect(parseSearchEnginesEnv(undefined)).toBeUndefined();
    expect(parseSearchEnginesEnv("   ")).toBeUndefined();
    expect(parseSearchEnginesEnv("google")).toBe("google");
    expect(parseSearchEnginesEnv("  google,bing  ")).toBe("google,bing");
  });

  it("rejects garbage instead of failing every search", () => {
    expect(parseSearchEnginesEnv("google; rm -rf")).toBeUndefined();
    expect(parseSearchEnginesEnv("x".repeat(201))).toBeUndefined();
  });
});

describe("WebSearchTool operator engines", () => {
  it("sends the operator default without any model-facing option", async () => {
    const calls: WebSearchRequest[] = [];
    const tool = makeTool(async (): Promise<WebSearchResponse> => {
      return { results: [], count: 0 };
    }, calls, "google");

    const params = tool.parseParams({ query: "bun docs" });
    expect("engines" in params).toBe(false);
    await tool.execute(params);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.engines).toBe("google");
  });

  it("ignores a model-supplied engines field and keeps the operator default", async () => {
    const calls: WebSearchRequest[] = [];
    const tool = makeTool(async (): Promise<WebSearchResponse> => {
      return { results: [], count: 0 };
    }, calls, "google");

    await tool.execute(tool.parseParams({ query: "bun docs", engines: "bing" }));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.engines).toBe("google");
  });

  it("omits engines when the operator configured none", async () => {
    const calls: WebSearchRequest[] = [];
    const tool = makeTool(async (): Promise<WebSearchResponse> => {
      return { results: [], count: 0 };
    }, calls);

    await tool.execute(tool.parseParams({ query: "bun docs" }));

    expect(calls[0]?.engines).toBeUndefined();
  });
});
