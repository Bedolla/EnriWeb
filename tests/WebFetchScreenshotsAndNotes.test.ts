/**
 * Tests for the screenshot surface (param parsing, wire payload, server
 * image-block split, text-formatter notes) and the web_search `fetch_note`
 * passthrough.
 *
 * @module tests/WebFetchScreenshotsAndNotes
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

import { parseWebFetchParams } from "../src/tools/WebFetchParamsParser.js";
import { WebFetchToolTextFormatter } from "../src/tools/WebFetchToolTextFormatter.js";
import type { WebFetchToolResult } from "../src/tools/WebFetchTool.js";
import { WebSearchTool } from "../src/tools/WebSearchTool.js";
import { EnriProxyClient, resolveMaxResponseBytes } from "../src/client/EnriProxyClient.js";
import type { WebFetchUrlRequest } from "../src/client/EnriProxyClient.js";

/**
 * Builds one minimal search tool with a stubbed proxy client.
 *
 * @param response - Response payload returned by the stub client.
 * @returns Tool instance.
 */
function buildSearchTool(response: Record<string, unknown>): WebSearchTool {
  const stubClient = {
    webSearch: async (): Promise<Record<string, unknown>> => response
  } as unknown as EnriProxyClient;
  return new WebSearchTool({
    createClient: (): EnriProxyClient => stubClient,
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    registryVerifier: {
      verifyFromSearchResults: async (): Promise<never[]> => []
    } as never
  });
}

describe("parseWebFetchParams screenshot", (): void => {
  it("accepts the documented modes", (): void => {
    for (const mode of ["auto", "force", "none"] as const) {
      const params = parseWebFetchParams({ url: "https://example.test", screenshot: mode });
      expect(params.screenshot).toBe(mode);
    }
  });

  it("degrades unknown and non-string values to undefined", (): void => {
    expect(parseWebFetchParams({ url: "https://example.test", screenshot: "always" }).screenshot).toBeUndefined();
    expect(parseWebFetchParams({ url: "https://example.test", screenshot: 1 }).screenshot).toBeUndefined();
    expect(parseWebFetchParams({ url: "https://example.test" }).screenshot).toBeUndefined();
  });
});

describe("EnriProxyClient.webFetch screenshot wire field", (): void => {
  it("sends the screenshot mode in the URL-mode payload", async (): Promise<void> => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res): void => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer): void => {
        chunks.push(chunk);
      });
      req.on("end", (): void => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: "x", status: 200, content_type: "text/plain", truncated: false })
        );
      });
    });
    await new Promise<void>((resolve): void => {
      server.listen(0, "127.0.0.1", (): void => {
        resolve();
      });
    });
    const address = server.address();
    const port: number = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new EnriProxyClient({ baseUrl: `http://127.0.0.1:${String(port)}`, apiKey: "key", timeoutMs: 5000 });
      const request: WebFetchUrlRequest = { url: "https://example.test", screenshot: "auto" };
      await client.webFetch(request, undefined);
    } finally {
      await new Promise<void>((resolve): void => {
        server.close((): void => {
          resolve();
        });
      });
    }
    expect(bodies[0]?.["screenshot"]).toBe("auto");
  });

  it("omits the field when the host did not pass it (server default auto)", async (): Promise<void> => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res): void => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer): void => {
        chunks.push(chunk);
      });
      req.on("end", (): void => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: "x", status: 200, content_type: "text/plain", truncated: false })
        );
      });
    });
    await new Promise<void>((resolve): void => {
      server.listen(0, "127.0.0.1", (): void => {
        resolve();
      });
    });
    const address = server.address();
    const port: number = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new EnriProxyClient({ baseUrl: `http://127.0.0.1:${String(port)}`, apiKey: "key", timeoutMs: 5000 });
      await client.webFetch({ url: "https://example.test" }, undefined);
    } finally {
      await new Promise<void>((resolve): void => {
        server.close((): void => {
          resolve();
        });
      });
    }
    expect("screenshot" in (bodies[0] ?? {})).toBe(false);
  });

  it("forwards an explicit none opt-out", async (): Promise<void> => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = createServer((req, res): void => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer): void => {
        chunks.push(chunk);
      });
      req.on("end", (): void => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ content: "x", status: 200, content_type: "text/plain", truncated: false })
        );
      });
    });
    await new Promise<void>((resolve): void => {
      server.listen(0, "127.0.0.1", (): void => {
        resolve();
      });
    });
    const address = server.address();
    const port: number = typeof address === "object" && address !== null ? address.port : 0;
    try {
      const client = new EnriProxyClient({ baseUrl: `http://127.0.0.1:${String(port)}`, apiKey: "key", timeoutMs: 5000 });
      await client.webFetch({ url: "https://example.test", screenshot: "none" }, undefined);
    } finally {
      await new Promise<void>((resolve): void => {
        server.close((): void => {
          resolve();
        });
      });
    }
    expect(bodies[0]?.["screenshot"]).toBe("none");
  });

  it("parses and forwards the analyze mode for blind models", (): void => {
    expect(parseWebFetchParams({ url: "https://example.test", screenshot: "analyze" }).screenshot).toBe("analyze");
  });

  it("formats server-side screenshot analyses as inline text", (): void => {
    const result = {
      content: "PERRABBIT GAME OVER",
      status: 200,
      content_type: "text/plain",
      truncated: false,
      url: "https://enrirego.test",
      screenshot_status: "analyzed" as const,
      screenshot_analyses: [
        "Juego de saltos con un conejo sobre fondo beige; texto GAME OVER centrado y la instrucción CLICK/TOUCH TO JUMP debajo."
      ]
    } as WebFetchToolResult;
    const text = WebFetchToolTextFormatter.format(result);
    expect(text).toContain("Análisis visual de la página (1 segmento(s)");
    expect(text).toContain("Segmento 1: Juego de saltos");
    expect(text).not.toContain("bloques de imagen");
  });
});

describe("WebFetchToolTextFormatter screenshot notes", (): void => {
  it("names captured segments for text-only clients", (): void => {
    const result = {
      content: "PERRABBIT",
      status: 200,
      content_type: "text/plain",
      truncated: false,
      url: "https://enrirego.test",
      screenshot_status: "captured" as const,
      screenshots: [
        { mime_type: "image/jpeg", base64: "ZgFrZQ==", width: 1280, height: 800, scroll_y: 0 }
      ]
    } as WebFetchToolResult;
    const text = WebFetchToolTextFormatter.format(result);
    expect(text).toContain("Capturas de pantalla: 1 segmento(s)");
    expect(text).toContain("1280x800 @scroll 0px");
    // Blind models get an explicit escape hatch toward the analyze mode.
    expect(text).toContain('repita esta llamada con screenshot="analyze"');
    // The base64 payload must never leak into the text channel.
    expect(text).not.toContain("ZgFrZQ==");
  });

  it("explains skipped screenshots", (): void => {
    const result = {
      content: "x",
      status: 200,
      content_type: "text/plain",
      truncated: false,
      url: "https://example.test",
      screenshot_status: "skipped" as const,
      screenshot_reason: "lane_unsupported"
    } as unknown as WebFetchToolResult;
    const text = WebFetchToolTextFormatter.format(result);
    expect(text).toContain("lane_unsupported");
  });
});

describe("WebSearchTool fetch_note passthrough", (): void => {
  it("projects the proxy auto-fetch note into the result and text output", async (): Promise<void> => {
    const tool = buildSearchTool({
      results: [{ url: "https://a.test", title: "A", snippet: "s" }],
      count: 1,
      fetch_note: "Auto-fetch no adjuntó contenidos: todos los candidatos estaban muertos."
    });
    const result = await tool.execute({ query: "anything" });
    expect(result.fetchNote).toContain("Auto-fetch");
    const text = tool.formatOutput(result);
    expect(text).toContain("todos los candidatos estaban muertos");
  });

  it("omits the note when the proxy did not send one", async (): Promise<void> => {
    const tool = buildSearchTool({
      results: [{ url: "https://a.test", title: "A", snippet: "s" }],
      count: 1
    });
    const result = await tool.execute({ query: "anything" });
    expect(result.fetchNote).toBeUndefined();
  });
});

describe("resolveMaxResponseBytes screenshot headroom", (): void => {
  it("keeps the documented floor for small budgets", (): void => {
    expect(resolveMaxResponseBytes(undefined)).toBe(20 * 1024 * 1024);
  });
});
