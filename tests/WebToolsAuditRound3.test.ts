/**
 * Regression tests for the EnriWeb audit round 3 fixes (EW-D1, EW-D3,
 * EW-D5, EW-D6, EW-D9): released-cursor pagination hints, camelCase arg
 * aliases, bounded Spanish JSON-parse tails, non-array search results, and
 * version-pinned npm package pages.
 */
import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import type {
  EnriProxyClient as EnriProxyClientPort,
  WebFetchRequest,
  WebFetchResponse
} from "../src/client/EnriProxyClient.js";
import {
  WebFetchTool,
  type WebFetchToolResult
} from "../src/tools/WebFetchTool.js";
import { WebSearchTool } from "../src/tools/WebSearchTool.js";
import type { WebSearchRegistryVerifier } from "../src/tools/WebSearchRegistryVerifier.js";

/**
 * Builds a WebFetchTool backed by a fake EnriProxy client.
 *
 * @param respond - Fake client response producer.
 * @param defaultMaxChars - Tool default budget.
 * @returns Tool instance wired to the fake client.
 */
function buildFetchTool(
  respond: (params: WebFetchRequest) => Promise<unknown> | unknown,
  defaultMaxChars: number = 80000
): WebFetchTool {
  return new WebFetchTool({
    createClient: (): EnriProxyClientPort => {
      const fake = {
        webFetch: async (params: WebFetchRequest): Promise<unknown> => await respond(params)
      };
      return fake as unknown as EnriProxyClientPort;
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    defaultMaxChars
  });
}

/**
 * Builds a WebSearchTool with a never-called client and a stub verifier.
 *
 * @returns Tool instance for parseParams assertions.
 */
function buildSearchTool(): WebSearchTool {
  const verifierStub: WebSearchRegistryVerifier = {
    verifyFromSearchResults: async (): Promise<never[]> => []
  } as unknown as WebSearchRegistryVerifier;
  return new WebSearchTool({
    createClient: (): EnriProxyClientPort => {
      throw new Error("not used");
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    registryVerifier: verifierStub
  });
}

describe("EW-D1: released-cursor pagination hints", () => {
  it("omits the cursor and its continuation hint on the exhausted final page (has_more=false)", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";
    const calls: WebFetchRequest[] = [];
    const tool = buildFetchTool((params: WebFetchRequest): unknown => {
      calls.push(params);
      if ("action" in params && (params as { action?: string }).action === "delete") {
        return { deleted: true, cursor };
      }
      return {
        content: "final page",
        status: 200,
        content_type: "text/plain",
        truncated: true,
        url: "https://example.com/doc",
        cursor,
        offset_chars: 4000,
        limit_chars: 20000,
        total_chars: 4010,
        has_more: false,
        next_offset_chars: 4010
      } satisfies WebFetchResponse;
    });

    const result = (await tool.execute({ cursor })) as WebFetchToolResult;

    expect(result.has_more).toBe(false);
    expect(result.cursor).toBeUndefined();
    expect(result.next_offset_chars).toBeUndefined();
    // The exhausted capture was released best-effort before returning.
    expect(
      calls.some((call: WebFetchRequest): boolean => (call as { action?: string }).action === "delete")
    ).toBe(true);
    const text = tool.formatOutput(result);
    expect(text).toContain("Lectura completa de la captura");
    expect(text).not.toContain('cursor="');
  });

  it("keeps the cursor hint on an intermediate page (has_more=true)", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";
    const tool = buildFetchTool((): WebFetchResponse => ({
      content: "middle page",
      status: 200,
      content_type: "text/plain",
      truncated: true,
      url: "https://example.com/doc",
      cursor,
      offset_chars: 20000,
      limit_chars: 20000,
      total_chars: 60000,
      has_more: true,
      next_offset_chars: 40000
    }));

    const result = (await tool.execute({ cursor })) as WebFetchToolResult;

    expect(result.cursor).toBe(cursor);
    const text = tool.formatOutput(result);
    expect(text).toContain(`cursor="${cursor}"`);
    expect(text).toContain("offset_chars=40000");
  });

  it("replaces the cursor hint with the complete-read note when has_more=false even if a cursor remains", () => {
    const tool = buildFetchTool((): WebFetchResponse => ({
      content: "",
      status: 200,
      content_type: "text/plain",
      truncated: false
    }));

    // Reduced URL read keeping a live cursor while the capture itself is
    // fully delivered: the pagination hint must not fire.
    const text = tool.formatOutput({
      content: "extract pack",
      status: 200,
      content_type: "text/plain",
      truncated: true,
      url: "https://example.com/doc",
      cursor: "123e4567-e89b-12d3-a456-426614174111",
      has_more: false,
      next_offset_chars: 11
    });

    expect(text).not.toContain('cursor="');
    expect(text).toContain("Lectura completa de la captura");
  });
});

describe("EW-D3: camelCase aliases and query batches", () => {
  it("accepts camelCase aliases for web_search filters", () => {
    const params = buildSearchTool().parseParams({
      query: "bun sqlite",
      maxResults: "7",
      allowedDomains: ["npmjs.com"],
      blockedDomains: ["spam.example"],
      searchPrompt: "looking for windows support"
    });

    expect(params.maxResults).toBe(7);
    expect(params.allowedDomains).toEqual(["npmjs.com"]);
    expect(params.blockedDomains).toEqual(["spam.example"]);
    expect(params.searchPrompt).toBe("looking for windows support");
  });

  it("accepts query as a 1-4 batch array normalized like queries", () => {
    const params = buildSearchTool().parseParams({
      query: ["bun sqlite", "bun sqlite", " bun:sqlite windows "]
    });

    expect(params.queries).toEqual(["bun sqlite", "bun:sqlite windows"]);
    expect(params.query).toBe("bun sqlite");
  });

  it("rejects a query batch larger than four and keeps explicit queries winning", () => {
    expect(() => buildSearchTool().parseParams({ query: ["a", "b", "c", "d", "e"] })).toThrow(
      /entre 1 y 4/u
    );

    const both = buildSearchTool().parseParams({
      query: ["ignored batch"],
      queries: ["wins"]
    });
    expect(both.queries).toEqual(["wins"]);
  });

  it("accepts camelCase aliases maxChars/offsetChars/limitChars for web_fetch", () => {
    const tool = buildFetchTool((): WebFetchResponse => ({
      content: "",
      status: 200,
      content_type: "text/plain",
      truncated: false
    }));

    const params = tool.parseParams({
      url: "https://example.com/docs",
      maxChars: "5000",
      offsetChars: 100,
      limitChars: 50
    });

    expect(params.maxChars).toBe(5000);
    expect(params.offsetChars).toBe(100);
    expect(params.limitChars).toBe(50);
  });
});

describe("EW-D6: non-array search results degrade honestly", () => {
  it("returns an empty result set when the proxy 200 omits results", async () => {
    const tool = new WebSearchTool({
      createClient: (): EnriProxyClientPort => {
        const fake = {
          webSearch: async (): Promise<unknown> => ({ count: 0 })
        };
        return fake as unknown as EnriProxyClientPort;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      registryVerifier: {
        verifyFromSearchResults: async (): Promise<never[]> => []
      } as unknown as WebSearchRegistryVerifier
    });

    const result = await tool.execute({ query: "anything" });

    expect(result.results).toEqual([]);
    expect(result.count).toBe(0);
    expect(tool.formatOutput(result)).toContain("No se encontraron resultados");
  });
});

describe("EW-D9: version-pinned npm package pages", () => {
  it("resolves the pinned registry manifest for /v/<version> npm pages", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = buildFetchTool((params: WebFetchRequest): WebFetchResponse => {
      calls.push(params);
      if (params.url === "https://registry.npmjs.org/chalk/4.0.0") {
        return {
          content: JSON.stringify({
            name: "chalk",
            version: "4.0.0",
            description: "Terminal colors"
          }),
          status: 200,
          content_type: "application/json",
          truncated: false
        };
      }
      return { content: "", status: 404, content_type: "text/plain", truncated: false };
    }, 20000);

    const result = (await tool.execute({
      url: "https://www.npmjs.com/package/chalk/v/4.0.0"
    })) as WebFetchToolResult;

    expect(calls[0]?.url).toBe("https://registry.npmjs.org/chalk/4.0.0");
    expect(result.content).toContain("Versión solicitada: 4.0.0");
    expect(result.content).not.toContain("Última versión");
  });

  it("pins scoped packages with a /v/<version> segment too", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = buildFetchTool((params: WebFetchRequest): WebFetchResponse => {
      calls.push(params);
      if (params.url === "https://registry.npmjs.org/%40scope%2Fname/1.2.3") {
        return {
          content: JSON.stringify({ name: "@scope/name", version: "1.2.3" }),
          status: 200,
          content_type: "application/json",
          truncated: false
        };
      }
      return { content: "", status: 404, content_type: "text/plain", truncated: false };
    }, 20000);

    const result = (await tool.execute({
      url: "https://www.npmjs.com/package/@scope/name/v/1.2.3"
    })) as WebFetchToolResult;

    expect(calls[0]?.url).toBe("https://registry.npmjs.org/%40scope%2Fname/1.2.3");
    expect(result.content).toContain("Versión solicitada: 1.2.3");
  });

  it("keeps resolving /latest for unversioned npm pages", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = buildFetchTool((params: WebFetchRequest): WebFetchResponse => {
      calls.push(params);
      if (params.url === "https://registry.npmjs.org/chalk/latest") {
        return {
          content: JSON.stringify({ name: "chalk", version: "5.4.1" }),
          status: 200,
          content_type: "application/json",
          truncated: false
        };
      }
      return { content: "", status: 404, content_type: "text/plain", truncated: false };
    }, 20000);

    const result = (await tool.execute({
      url: "https://www.npmjs.com/package/chalk"
    })) as WebFetchToolResult;

    expect(calls[0]?.url).toBe("https://registry.npmjs.org/chalk/latest");
    expect(result.content).toContain("Última versión: 5.4.1");
  });
});

describe("EW-D5: bounded Spanish JSON-parse tails", () => {
  /**
   * Starts a one-shot HTTP server answering a non-JSON 200 body.
   *
   * @returns Server instance and its base URL.
   */
  const startPlainTextServer = async (): Promise<{ server: Server; baseUrl: string }> => {
    const server = createServer((_req: IncomingMessage, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end("<html>definitely not json</html>");
    });
    await new Promise<void>((resolve): void => {
      server.listen(0, "127.0.0.1", (): void => resolve());
    });
    const address = server.address() as AddressInfo;
    return { server, baseUrl: `http://127.0.0.1:${address.port}` };
  };

  it("wraps the V8 parse failure in a Spanish tail bounded to 80 chars", async () => {
    const { server, baseUrl } = await startPlainTextServer();
    try {
      const client = new EnriProxyClient({ baseUrl, apiKey: "test", timeoutMs: 2000 });

      await expect(client.webFetch({ url: "https://example.com" })).rejects.toThrow(
        /cuerpo de respuesta no parseable \(Unexpected/u
      );
      await expect(client.webSearch({ query: "test" })).rejects.toThrow(
        /Respuesta no JSON de EnriProxy en \/v1\/tools\/web_search/u
      );
    } finally {
      await new Promise<void>((resolve): void => {
        server.close((): void => resolve());
      });
    }
  });
});
