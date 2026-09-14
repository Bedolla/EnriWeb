import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EnriProxyHttpError } from "../src/client/EnriProxyClient.js";
import { EnriWebServer } from "../src/server/EnriWebServer.js";
import type { WebFetchTool } from "../src/tools/WebFetchTool.js";
import type { WebSearchTool } from "../src/tools/WebSearchTool.js";

/**
 * Creates one linked client/server pair with stub tools.
 *
 * @param stubs - Tool stubs and behavior flags.
 * @returns Connected MCP client.
 */
async function createLinkedClient(stubs: {
  fetchExecute?: (params: unknown, signal?: AbortSignal) => Promise<unknown>;
  searchExecute?: (params: unknown, signal?: AbortSignal) => Promise<unknown>;
}): Promise<Client> {
  const webFetchTool = {
    parseParams: (raw: unknown): unknown => raw,
    execute: stubs.fetchExecute ?? (async () => ({ url: "https://example.com", content: "ok" })),
    formatOutput: (): string => "formatted",
    getDefaultMaxChars: (): number => 80000
  } as unknown as WebFetchTool;
  const webSearchTool = {
    parseParams: (raw: unknown): unknown => raw,
    execute: stubs.searchExecute ?? (async () => ({ query: "q", results: [] })),
    formatOutput: (): string => "formatted"
  } as unknown as WebSearchTool;

  const server = new EnriWebServer({ name: "EnriWeb", version: "test", webSearchTool, webFetchTool });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  await client.connect(clientTransport);
  return client;
}

describe("EnriWebServer CallTool", () => {
  it("routes web_fetch and returns text plus structuredContent", async () => {
    const client = await createLinkedClient({});
    try {
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toBe("formatted");
      expect(result.structuredContent).toMatchObject({ url: "https://example.com" });
    } finally {
      await client.close();
    }
  });

  it("marks unknown tools as errors in Spanish", async () => {
    const client = await createLinkedClient({});
    try {
      const result = await client.callTool({ name: "nope", arguments: {} });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("desconocida");
    } finally {
      await client.close();
    }
  });

  it("formats non-proxy failures with one bounded technical detail instead of duplicating the raw message", async () => {
    const client = await createLinkedClient({
      fetchExecute: async (): Promise<unknown> => {
        throw new Error("fetch failed");
      }
    });
    try {
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBe(true);
      const text: string = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(text).toContain("La operación falló por un error de transporte local.");
      expect(text.split("fetch failed").length - 1).toBe(1); // appears exactly once
      expect(text.length).toBeLessThanOrEqual("La operación falló por un error de transporte local.".length + 2 + "\n\ndetalle_tecnico: ".length + 500);
    } finally {
      await client.close();
    }
  });

  it("treats socket-reset \"aborted\" transport failures as retryable tool errors, not cancellations", async () => {
    const client = await createLinkedClient({
      fetchExecute: async (): Promise<unknown> => {
        throw new Error("aborted");
      }
    });
    try {
      // A rethrown cancellation would reject the MCP call; a retryable
      // transport failure resolves as an isError tool result in Spanish.
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBe(true);
      const text: string = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(text.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });

  it("appends Spanish guidance to known proxy diagnostics", async () => {
    const client = await createLinkedClient({
      fetchExecute: async (): Promise<unknown> => {
        throw new EnriProxyHttpError("El fetch web falló (HTTP 400).", 400, {}, "{'max_results' must be between 1 and 20}");
      }
    });
    try {
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("Guía:");
    } finally {
      await client.close();
    }
  });

  it("recognizes the current Spanish max_results diagnostic from the proxy", async () => {
    const client = await createLinkedClient({
      fetchExecute: async (): Promise<unknown> => {
        throw new EnriProxyHttpError(
          "El fetch web falló (HTTP 400).",
          400,
          {},
          JSON.stringify({ message: "'max_results' debe estar entre 1 y 20." })
        );
      }
    });
    try {
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("Guía: pida max_results entre 1 y el límite");
    } finally {
      await client.close();
    }
  });

  it("translates known Spanish proxy bodies without leaking raw payloads", async () => {
    const client = await createLinkedClient({
      fetchExecute: async (): Promise<unknown> => {
        throw new EnriProxyHttpError(
          "El fetch web falló (HTTP 502).",
          502,
          {},
          JSON.stringify({ type: "bad_gateway", message: "El fetch web no pudo recuperar el contenido." })
        );
      }
    });
    try {
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("El fetch web no pudo recuperar el contenido");
      expect(content[0]?.text).toContain("reintentable");
      expect(content[0]?.text).not.toContain("detalle_tecnico");
    } finally {
      await client.close();
    }
  });

  it("maps the current Spanish missing-arguments diagnostics from the proxy", async () => {
    const cases: Array<{ body: string; expected: RegExp }> = [
      { body: "Falta o es inválido 'query'.", expected: /envíe query\/queries para buscar o url\/cursor para leer/u },
      { body: "Falta o es inválido 'url' o 'cursor'.", expected: /envíe query\/queries para buscar o url\/cursor para leer/u }
    ];

    for (const testCase of cases) {
      const client = await createLinkedClient({
        fetchExecute: async (): Promise<unknown> => {
          throw new EnriProxyHttpError(
            "El fetch web falló (HTTP 400).",
            400,
            {},
            JSON.stringify({ message: testCase.body })
          );
        }
      });
      try {
        const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
        expect(result.isError).toBe(true);
        const content = result.content as Array<{ type: string; text: string }>;
        expect(content[0]?.text).toMatch(testCase.expected);
      } finally {
        await client.close();
      }
    }
  });

  it("maps cursor, api-key, method, and search-unavailable diagnostics", async () => {
    const cases: Array<{ body: string; expected: RegExp }> = [
      { body: "Cursor no encontrado o expirado.", expected: /no reintente este cursor/i },
      { body: "Falta la API key.", expected: /ENRIPROXY_API_KEY/ },
      { body: "Método no permitido.", expected: /no cambie su llamada/i },
      {
        body: "La búsqueda web falló en todos los proveedores configurados (SearXNG y DuckDuckGo+Jina).",
        expected: /aflojelos y reintente/i
      }
    ];
    for (const testCase of cases) {
      const client = await createLinkedClient({
        fetchExecute: async (): Promise<unknown> => {
          throw new EnriProxyHttpError("El fetch web falló.", 400, {}, testCase.body);
        }
      });
      try {
        const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
        const content = result.content as Array<{ type: string; text: string }>;
        expect(result.isError).toBe(true);
        expect(content[0]?.text).toMatch(testCase.expected);
      } finally {
        await client.close();
      }
    }
  });

  it("preserves unknown diagnostics under detalle_tecnico truncated to 500 chars", async () => {
    const client = await createLinkedClient({
      fetchExecute: async (): Promise<unknown> => {
        throw new EnriProxyHttpError(
          "El fetch web falló (HTTP 500).",
          500,
          {},
          `internal_error: ${"x".repeat(900)}`
        );
      }
    });
    try {
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("detalle_tecnico:");
      const detail = content[0]?.text.split("detalle_tecnico: ")[1] ?? "";
      expect(detail.length).toBeLessThanOrEqual(500);
    } finally {
      await client.close();
    }
  });

  it("reports subfetch timeouts as retryable errors instead of cancellations", async () => {
    const client = await createLinkedClient({
      fetchExecute: async (): Promise<unknown> => {
        throw new Error("La petición expiró después de 20000ms");
      }
    });
    try {
      const result = await client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toContain("reintentable");
    } finally {
      await client.close();
    }
  });

  it("exposes outputSchema as a root sibling of inputSchema on both tools", async () => {
    const client = await createLinkedClient({});
    try {
      const listed = await client.listTools();
      const search = listed.tools.find((tool) => tool.name === "web_search");
      const fetchTool = listed.tools.find((tool) => tool.name === "web_fetch");

      expect(search?.outputSchema).toBeDefined();
      expect(fetchTool?.outputSchema).toBeDefined();
      expect(search?.inputSchema).not.toHaveProperty("outputSchema");
      expect(fetchTool?.inputSchema).not.toHaveProperty("outputSchema");

      const searchOutput = search?.outputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(searchOutput.properties ?? {})).toEqual(
        expect.arrayContaining(["results", "count", "verified", "fetchedContents"])
      );

      const fetchOutput = fetchTool?.outputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(fetchOutput.properties ?? {})).toEqual(
        expect.arrayContaining([
          "content",
          "status",
          "truncated",
          "cursor",
          "deleted",
          "range_applied",
          "ranges"
        ])
      );

      const fetchInput = fetchTool?.inputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(fetchInput?.properties ?? {})).toEqual(
        expect.arrayContaining(["action", "ranges", "cursor"])
      );
    } finally {
      await client.close();
    }
  });

  it("documents honest search timing, max_results clamping, and next_offset_chars", async () => {
    const client = await createLinkedClient({});
    try {
      const listed = await client.listTools();
      const search = listed.tools.find((tool) => tool.name === "web_search");
      const fetchTool = listed.tools.find((tool) => tool.name === "web_fetch");

      // Honest worst-case verification budget (NuGet chains up to 4 sequential
      // fetches per entity; GitHub latest + 3 pages).
      expect(search?.description).toContain("~120 s");
      expect(search?.description).not.toContain("~30 s");
      // The proxy now clamps max_results instead of answering HTTP 400.
      expect(search?.description).toContain("se recortan al límite");
      expect(search?.description).not.toContain("HTTP 400");

      const searchInput = search?.inputSchema as { properties?: Record<string, { description?: string }> };
      expect(searchInput?.properties?.["max_results"]?.description).toContain(
        "se recortan al límite"
      );

      const fetchOutput = fetchTool?.outputSchema as { properties?: Record<string, unknown> };
      expect(Object.keys(fetchOutput.properties ?? {})).toContain("next_offset_chars");

      const fetchInput = fetchTool?.inputSchema as {
        properties?: Record<string, { description?: string }>;
      };
      expect(fetchInput?.properties?.["offset_chars"]?.description).toContain(
        "rango local sobre el contenido devuelto"
      );
    } finally {
      await client.close();
    }
  });

  it("rethrows caller aborts instead of reporting a tool error", async () => {
    const server = new EnriWebServer({
      name: "EnriWeb",
      version: "test",
      webSearchTool: {
        parseParams: (raw: unknown): unknown => raw,
        execute: async () => ({ query: "q", results: [] }),
        formatOutput: (): string => "formatted"
      } as unknown as WebSearchTool,
      webFetchTool: {
        parseParams: (raw: unknown): unknown => raw,
        execute: async (_params: unknown, signal?: AbortSignal): Promise<unknown> => {
          await new Promise<never>((_resolve, reject): void => {
            signal?.addEventListener("abort", () => reject(new Error("La petición fue cancelada por el cliente.")), {
              once: true
            });
          });
          throw new Error("unreachable");
        },
        formatOutput: (): string => "formatted",
        getDefaultMaxChars: (): number => 80000
      } as unknown as WebFetchTool
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
    await client.connect(clientTransport);
    try {
      const pending = client.callTool({ name: "web_fetch", arguments: { url: "https://example.com" } });
      await clientTransport.close();
      await expect(pending).rejects.toThrow();
    } finally {
      await client.close().catch(() => undefined);
    }
  });
});
