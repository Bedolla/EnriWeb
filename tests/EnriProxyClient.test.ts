/**
 * Tests for EnriWeb EnriProxyClient behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { EnriProxyClient, EnriProxyHttpError, resolveMaxResponseBytes } from "../src/client/EnriProxyClient.js";

/**
 * Recorded HTTP request payload for assertions.
 */
interface RecordedRequest {
  /**
   * Request URL.
   */
  readonly url: string;

  /**
   * HTTP method.
   */
  readonly method: string;

  /**
   * Request headers.
   */
  readonly headers: Record<string, string | string[] | undefined>;

  /**
   * Parsed JSON body.
   */
  readonly body: Record<string, unknown>;
}

/**
 * Reads and parses a JSON request body.
 *
 * @param req - Incoming HTTP request
 * @returns Parsed JSON object
 */
const readJsonBody = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
};

/**
 * Starts a temporary HTTP server for request capture.
 *
 * @param handler - Request handler
 * @returns Server instance and base URL
 */
const startServer = async (
  handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void
): Promise<{ readonly server: Server; readonly baseUrl: string }> => {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
};

describe("EnriProxyClient error handling", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: "boom" }));
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  });

  it("throws EnriProxyHttpError for webSearch failures", async () => {
    const client = new EnriProxyClient({
      baseUrl,
      apiKey: "test",
      timeoutMs: 1000
    });

    await expect(client.webSearch({ query: "test" })).rejects.toBeInstanceOf(EnriProxyHttpError);
  });

  it("throws EnriProxyHttpError for webFetch failures", async () => {
    const client = new EnriProxyClient({
      baseUrl,
      apiKey: "test",
      timeoutMs: 1000
    });

    await expect(client.webFetch({ url: "https://example.com" })).rejects.toBeInstanceOf(
      EnriProxyHttpError
    );
  });

  it("rejects immediately when the caller signal is already aborted", async () => {
    const client = new EnriProxyClient({
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test",
      timeoutMs: 1000
    });
    const controller = new AbortController();
    controller.abort();

    await expect(client.webSearch({ query: "test" }, controller.signal)).rejects.toThrow(/cancelada/i);
    await expect(client.webFetch({ url: "https://example.com" }, controller.signal)).rejects.toThrow(
      /cancelada/i
    );
  });
});

describe("EnriProxyClient request payloads", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        server?.close(() => resolve());
      } catch {
        resolve();
      }
    });
    server = null;
  });

  it("sends payload for webSearch with filters", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ results: [], count: 0 }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await client.webSearch({
      query: "enrirego github url",
      maxResults: 5,
      recency: "oneMonth",
      allowedDomains: ["github.com"],
      blockedDomains: ["example.com"],
      searchPrompt: "return the exact profile url"
    });

    expect(recorded).not.toBeNull();
    expect(recorded?.url).toBe("/v1/tools/web_search");
    expect(recorded?.method).toBe("POST");
    expect(recorded?.headers.authorization).toBe("Bearer test-key");
    expect(recorded?.body).toMatchObject({
      query: "enrirego github url",
      max_results: 5,
      recency: "oneMonth",
      allowed_domains: ["github.com"],
      blocked_domains: ["example.com"],
      search_prompt: "return the exact profile url"
    });
  });

  it("sends payload for webFetch", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ url: "https://example.com", content: "ok" }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await client.webFetch({
      url: "https://example.com/docs",
      prompt: "summarize",
      maxChars: 1234
    });

    expect(recorded).not.toBeNull();
    expect(recorded?.url).toBe("/v1/tools/web_fetch");
    expect(recorded?.method).toBe("POST");
    expect(recorded?.headers.authorization).toBe("Bearer test-key");
    expect(recorded?.body).toMatchObject({
      url: "https://example.com/docs",
      prompt: "summarize",
      max_chars: 1234
    });
    expect(recorded?.body).not.toHaveProperty("format");
  });

  it("sends the format field for webFetch when requested", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ url: "https://example.com", content: "ok" }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await client.webFetch({
      url: "https://example.com/docs",
      format: "markdown"
    });

    expect(recorded?.body).toMatchObject({
      url: "https://example.com/docs",
      format: "markdown"
    });
  });

  it("omits zero limits and hash-only anchors, and normalizes budgets", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ url: "https://example.com", content: "ok" }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    await client.webFetch({
      cursor: "00000000-0000-4000-8000-000000000000",
      offsetChars: 0,
      limitChars: 0,
      maxChars: Number.NaN,
      anchor: "###"
    } as never);

    expect(recorded?.body).not.toHaveProperty("limit_chars");
    expect(recorded?.body).not.toHaveProperty("max_chars");
    expect(recorded?.body).not.toHaveProperty("anchor");
    expect(recorded?.body).toMatchObject({
      cursor: "00000000-0000-4000-8000-000000000000",
      offset_chars: 0
    });
  });
});

describe("EnriProxyClient cursor deletion", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      try {
        server?.closeAllConnections();
        server?.close(() => resolve());
      } catch {
        resolve();
      }
    });
    server = null;
  });

  it("sends {cursor, action:'delete'} and surfaces the deleted outcome", async () => {
    let recorded: RecordedRequest | null = null;
    const started = await startServer(async (req, res) => {
      const body = await readJsonBody(req);
      recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body
      };
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ deleted: true, cursor: body["cursor"] }));
    });
    server = started.server;

    const client = new EnriProxyClient({
      baseUrl: started.baseUrl,
      apiKey: "test-key",
      timeoutMs: 1000
    });

    const response = await client.webFetch({
      cursor: "00000000-0000-4000-8000-000000000000",
      action: "delete"
    });

    expect(recorded?.body).toMatchObject({
      cursor: "00000000-0000-4000-8000-000000000000",
      action: "delete"
    });
    expect(response.deleted).toBe(true);
  });
});

describe("EnriProxyClient subfetch abort labeling", () => {
  const startHangingServer = async (): Promise<{ readonly server: Server; readonly baseUrl: string }> =>
    startServer(() => {
      // Accepts requests and never answers.
    });

  it("labels a subfetch timeout as an expiration, not a client cancellation", async () => {
    const started = await startHangingServer();

    try {
      const client = new EnriProxyClient({
        baseUrl: started.baseUrl,
        apiKey: "test",
        timeoutMs: 5000
      });
      const caller = new AbortController();
      const combined: AbortSignal = AbortSignal.any([caller.signal, AbortSignal.timeout(80)]);

      await expect(
        client.webFetch(
          { url: "https://example.com" },
          combined,
          { callerSignal: caller.signal, subfetchTimeoutMs: 80 }
        )
      ).rejects.toThrow(/expiró después de 80ms/);
    } finally {
      started.server.closeAllConnections();
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });

  it("keeps reporting caller aborts as client cancellations", async () => {
    const started = await startHangingServer();

    try {
      const client = new EnriProxyClient({
        baseUrl: started.baseUrl,
        apiKey: "test",
        timeoutMs: 5000
      });
      const caller = new AbortController();
      const combined: AbortSignal = AbortSignal.any([caller.signal, AbortSignal.timeout(5000)]);
      setTimeout(() => caller.abort(), 60);

      await expect(
        client.webFetch(
          { url: "https://example.com" },
          combined,
          { callerSignal: caller.signal, subfetchTimeoutMs: 5000 }
        )
      ).rejects.toThrow(/cancelada por el cliente/);
    } finally {
      started.server.closeAllConnections();
      await new Promise<void>((resolve) => started.server.close(() => resolve()));
    }
  });
});

describe("EnriProxyClient response size ceiling", () => {
  it("derives the cap from max_chars instead of the flat 20MB", () => {
    expect(resolveMaxResponseBytes(undefined)).toBe(20 * 1024 * 1024);
    expect(resolveMaxResponseBytes(200_000)).toBe(20 * 1024 * 1024);
    expect(resolveMaxResponseBytes(4_000_000)).toBe(6 * 4_000_000 + 1024 * 1024);
  });

  it("accepts a >20MB escaped payload for a 4M-char budget", async () => {
    let server: Server | null = null;
    try {
      const payload: string = JSON.stringify({
        content: "a\"b\nc".repeat(3_000_000),
        status: 200,
        content_type: "text/plain",
        truncated: true
      });
      expect(Buffer.byteLength(payload, "utf8")).toBeGreaterThan(20 * 1024 * 1024);

      const started = await startServer((_req, res) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(payload);
      });
      server = started.server;

      const client = new EnriProxyClient({
        baseUrl: started.baseUrl,
        apiKey: "test",
        timeoutMs: 30_000
      });

      const response = await client.webFetch({ url: "https://example.com/big", maxChars: 4_000_000 });
      expect(response.status).toBe(200);
    } finally {
      if (server) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server?.close(() => resolve()));
      }
    }
  });
});
