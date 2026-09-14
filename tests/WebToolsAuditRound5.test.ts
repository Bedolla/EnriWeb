import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EnriWebServer } from "../src/server/EnriWebServer.js";
import type { WebFetchTool } from "../src/tools/WebFetchTool.js";
import type { WebSearchTool } from "../src/tools/WebSearchTool.js";
import { WebSearchTool as WebSearchToolInstance } from "../src/tools/WebSearchTool.js";

/**
 * Creates one linked client/server pair with stub tools.
 *
 * @returns Connected MCP client.
 */
async function createLinkedClient(): Promise<Client> {
  const webFetchTool = {
    parseParams: (raw: unknown): unknown => raw,
    execute: async () => ({ url: "https://example.com", content: "ok" }),
    formatOutput: (): string => "formatted",
    getDefaultMaxChars: (): number => 80000
  } as unknown as WebFetchTool;
  const webSearchTool = {
    parseParams: (raw: unknown): unknown => raw,
    execute: async () => ({ query: "q", results: [] }),
    formatOutput: (): string => "formatted"
  } as unknown as WebSearchTool;

  const server = new EnriWebServer({ name: "EnriWeb", version: "test", webSearchTool, webFetchTool });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("EnriWeb MCP round 5 parity fixes", (): void => {
  it("declares query as string-or-batch (anyOf) so schema-validating clients accept batches", async (): Promise<void> => {
    const client: Client = await createLinkedClient();
    try {
      const listed = await client.listTools();
      const search = listed.tools.find((tool): boolean => tool.name === "web_search");
      const searchInput = search?.inputSchema as {
        properties?: Record<string, { anyOf?: Array<{ type?: string; maxItems?: number }> }>;
      };
      const querySchema = searchInput?.properties?.["query"];
      expect(querySchema?.anyOf).toBeDefined();
      expect(querySchema?.anyOf?.map((alt: { type?: string }): string | undefined => alt.type)).toEqual(
        expect.arrayContaining(["string", "array"]),
      );
      const arrayAlt = querySchema?.anyOf?.find((alt: { type?: string }): boolean => alt.type === "array");
      expect(arrayAlt?.maxItems).toBe(4);
    } finally {
      await client.close();
    }
  });

  it("documents the full 11-part enri_parts list including drive and nota", async (): Promise<void> => {
    const client: Client = await createLinkedClient();
    try {
      const listed = await client.listTools();
      const fetchTool = listed.tools.find((tool): boolean => tool.name === "web_fetch");
      expect(fetchTool?.description).toContain(
        "sections,post,ld,imagenes,variantes,media,links,drive,nota,archivos,body",
      );
    } finally {
      await client.close();
    }
  });

  it("pluralizes the single-result search header in Spanish", (): void => {
    const tool: WebSearchToolInstance = new WebSearchToolInstance(
      {
        createClient: (): never => {
          throw new Error("not used");
        },
        defaultServerUrl: "https://proxy.example.com",
        defaultApiKey: "key",
        defaultTimeoutMs: 1000,
        registryVerifier: null
      } as unknown as ConstructorParameters<typeof WebSearchToolInstance>[0]
    );

    const single = tool.formatOutput({
      query: "one",
      results: [{ url: "https://example.com", title: "Solo" }],
      count: 1
    } as Parameters<WebSearchToolInstance["formatOutput"]>[0]);
    expect(single).toContain("(1 encontrado):");

    const many = tool.formatOutput({
      query: "many",
      results: [
        { url: "https://a.example.com", title: "A" },
        { url: "https://b.example.com", title: "B" },
      ],
      count: 2
    } as Parameters<WebSearchToolInstance["formatOutput"]>[0]);
    expect(many).toContain("(2 encontrados):");
  });
});
