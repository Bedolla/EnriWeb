import { describe, expect, it } from "vitest";

import { EnriProxyHttpError } from "../src/client/EnriProxyClient.js";
import type {
  EnriProxyClient,
  WebFetchRequest,
  WebFetchResponse
} from "../src/client/EnriProxyClient.js";
import {
  WebFetchTool,
  type WebFetchToolDeleteResult,
  type WebFetchToolRangesResult,
  type WebFetchToolResult
} from "../src/tools/WebFetchTool.js";

describe("WebFetchTool.parseParams", () => {
  it("rejects missing url and cursor", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    expect(() => tool.parseParams({})).toThrow(/url|cursor/i);
  });

  it("accepts UUID cursors and rejects invented cursor strings", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(tool.parseParams({ cursor: uuid }).cursor).toBe(uuid);
    expect(() => tool.parseParams({ cursor: "cur-123" })).toThrow(/cursor/i);
  });

  it("rejects non-http urls", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    expect(() => tool.parseParams({ url: "ftp://example.com" })).toThrow(/url/i);
  });

  it("a valid cursor wins over an invalid coexisting url (labels degrade, calls do not fail)", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    // Invalid url + valid cursor: the call must page the capture instead of
    // hard-failing (the url degrades to an absent display label).
    const params = tool.parseParams({ cursor: uuid, url: "not-a-url" });
    expect(params.cursor).toBe(uuid);
    expect(params.url).toBeUndefined();
    // A still-http url next to a cursor survives as the display label.
    const labeled = tool.parseParams({ cursor: uuid, url: "https://example.com/doc" });
    expect(labeled.cursor).toBe(uuid);
    expect(labeled.url).toBe("https://example.com/doc");
  });

  it("maps snake_case fields to params", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const params = tool.parseParams({
      url: "https://example.com/docs",
      prompt: "summarize",
      max_chars: "1234",
      format: "markdown"
    });

    expect(params.url).toBe("https://example.com/docs");
    expect(params.prompt).toBe("summarize");
    expect(params.maxChars).toBe(1234);
    expect(params.format).toBe("markdown");
  });

  it("degrades unknown formats to the default instead of failing", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const plain = tool.parseParams({ url: "https://example.com" });
    expect(plain.format).toBeUndefined();

    expect(tool.parseParams({ url: "https://example.com", format: "pdf" }).format).toBeUndefined();
    expect(tool.parseParams({ url: "https://example.com", format: 42 }).format).toBeUndefined();

    const html = tool.parseParams({ url: "https://example.com", format: "html" });
    expect(html.format).toBe("html");
  });

  it("maps projection fields with safe defaults", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const params = tool.parseParams({
      url: "https://example.com/docs",
      format: "markdown",
      content: "main",
      include_links: true,
      include_metadata: true,
      anchor: "#installation"
    });

    expect(params.format).toBe("markdown");
    expect(params.content).toBe("main");
    expect(params.includeLinks).toBe(true);
    expect(params.includeMetadata).toBe(true);
    expect(params.anchor).toBe("installation");

    const defaults = tool.parseParams({ url: "https://example.com/docs" });
    expect(defaults.content).toBeUndefined();
    expect(defaults.includeLinks).toBeUndefined();
    expect(defaults.includeMetadata).toBeUndefined();
    expect(defaults.anchor).toBeUndefined();

    // Invalid content values degrade to the documented default ("main").
    expect(tool.parseParams({ url: "https://example.com/docs", content: "side" }).content).toBeUndefined();
  });

  it("rejects non-positive max_chars", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    expect(tool.parseParams({ url: "https://example.com", max_chars: 0 }).maxChars).toBeUndefined();
    expect(tool.parseParams({ url: "https://example.com", max_chars: -5 }).maxChars).toBeUndefined();
  });

  it("appends the EnriVision hint for PDF responses and keeps text responses clean", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const pdfOutput = tool.formatOutput({
      content: "Texto del PDF extraído.",
      status: 200,
      content_type: "application/pdf",
      truncated: false,
      url: "https://example.com/doc.pdf"
    });

    expect(pdfOutput).toContain("analyze_media");
    expect(pdfOutput).toContain("EnriVision");
    expect(pdfOutput).toContain("https://example.com/doc.pdf");
    expect(pdfOutput).toContain("Texto del PDF extraído");

    const textOutput = tool.formatOutput({
      content: "Title: Docs",
      status: 200,
      content_type: "text/html",
      truncated: false,
      url: "https://example.com/docs"
    });

    expect(textOutput).not.toContain("analyze_media");
    expect(textOutput).not.toContain("EnriVision");
  });

  it("appends non-2xx coaching, cursor hints, and the untrusted note where applicable", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const notFoundOutput = tool.formatOutput({
      content: "Recurso ausente.",
      status: 404,
      content_type: "text/html",
      truncated: false,
      url: "https://example.com/missing"
    });
    expect(notFoundOutput).toContain("HTTP 404");
    expect(notFoundOutput).toContain("NO es error de la herramienta");
    expect(notFoundOutput).not.toContain("cursor=");

    const truncatedOutput = tool.formatOutput({
      content: "a".repeat(3000),
      status: 200,
      content_type: "text/html",
      truncated: true,
      url: "https://example.com/long",
      cursor: "cur-123"
    });
    expect(truncatedOutput).toContain('cursor="cur-123"');
    expect(truncatedOutput).toContain("No invente valores de cursor");

    const successOutput = tool.formatOutput({
      content: "Título: Docs",
      status: 200,
      content_type: "text/html",
      truncated: false,
      url: "https://example.com/docs"
    });
    expect(successOutput).toContain("datos no confiables");
    expect(successOutput).toContain("Cite esta URL");
    expect(successOutput).not.toContain("HTTP 200");
  });

  it("guides max_chars retry for truncated output without cursor and hints binary media", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const noCursorOutput = tool.formatOutput({
      content: "a".repeat(3000),
      status: 200,
      content_type: "text/html",
      truncated: true,
      url: "https://example.com/npm-pkg"
    });
    expect(noCursorOutput).toContain("max_chars");
    expect(noCursorOutput).not.toContain("cursor=");

    const imageOutput = tool.formatOutput({
      content: "",
      status: 200,
      content_type: "image/png",
      truncated: false,
      url: "https://example.com/pic.png"
    });
    expect(imageOutput).toContain("analyze_media");
  });

  it("accepts url-mode offset/limit and applies a local slice over the returned content", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const params = tool.parseParams({
      url: "https://example.com/docs",
      offset_chars: 500,
      limit_chars: 100
    });
    expect(params.offsetChars).toBe(500);
    expect(params.limitChars).toBe(100);

    expect(tool.parseParams({ url: "https://example.com/docs", offset: -1 }).offsetChars).toBeUndefined();
    // A zero limit still means "no explicit limit".
    expect(tool.parseParams({ url: "https://example.com/docs", limit: 0 }).limitChars).toBeUndefined();
  });

  it("normalizes hash-only anchors to undefined", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    expect(tool.parseParams({ url: "https://example.com/docs", anchor: "###" }).anchor).toBeUndefined();
    expect(tool.parseParams({ url: "https://example.com/docs", anchor: "#installation" }).anchor).toBe(
      "installation"
    );
  });

  it("accepts action delete only with a cursor and ignores other actions", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(tool.parseParams({ action: "delete", cursor: uuid }).action).toBe("delete");
    expect(tool.parseParams({ url: "https://example.com", action: "read" }).action).toBeUndefined();
    expect(() => tool.parseParams({ action: "delete" })).toThrow(/cursor/i);
  });

  it("validates ranges shape, aliases, and the 10-range bound", () => {
    const tool = new WebFetchTool({
      createClient: () => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const params = tool.parseParams({
      url: "https://example.com/docs",
      ranges: [
        { offset_chars: 0, limit_chars: 5000 },
        { offsetChars: 120000 },
        { offset: 4, limit: 0 }
      ]
    });
    expect(params.ranges).toEqual([
      { offsetChars: 0, limitChars: 5000 },
      { offsetChars: 120000, limitChars: undefined },
      { offsetChars: 4, limitChars: undefined }
    ]);

    expect(tool.parseParams({ url: "https://example.com/docs", ranges: [] }).ranges).toBeUndefined();
    expect(() =>
      tool.parseParams({
        url: "https://example.com/docs",
        ranges: Array.from({ length: 11 }, () => ({ offset_chars: 0 }))
      })
    ).toThrow(/máximo de 10 rangos/i);
    expect(() => tool.parseParams({ url: "https://example.com/docs", ranges: [{ offset_chars: -1 }] })).toThrow(
      /no negativo/i
    );
    expect(() => tool.parseParams({ url: "https://example.com/docs", ranges: ["x"] })).toThrow(
      /objeto/i
    );
  });
});

describe("WebFetchTool.execute", () => {
  it("sends the configured default max_chars so the documented default governs", async () => {
    const calls: WebFetchRequest[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            return {
              content: "ok",
              status: 200,
              content_type: "text/plain",
              truncated: false
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const result = await tool.execute({ url: "https://example.com" });

    expect(result.content).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxChars).toBe(80000);
  });

  it("sends explicit projection defaults matching the documented schema", async () => {
    const calls: WebFetchRequest[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            return {
              content: "ok",
              status: 200,
              content_type: "text/html",
              truncated: false
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    await tool.execute({ url: "https://example.com/docs" });

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    expect(sent).toMatchObject({
      url: "https://example.com/docs",
      format: "text",
      content: "main",
      includeLinks: true,
      includeMetadata: false
    });
  });

  it("clamps max_chars to the shared 4M ceiling", async () => {
    const calls: WebFetchRequest[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            return {
              content: "ok",
              status: 200,
              content_type: "text/plain",
              truncated: false
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    await tool.execute({ url: "https://example.com/docs", maxChars: 100_000_000 });

    expect(calls[0]?.maxChars).toBe(4_000_000);
  });

  it("keeps explicit projection overrides untouched", async () => {
    const calls: WebFetchRequest[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            return {
              content: "ok",
              status: 200,
              content_type: "text/html",
              truncated: false
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    await tool.execute({
      url: "https://example.com/docs",
      format: "markdown",
      content: "full",
      includeLinks: false,
      includeMetadata: true
    });

    expect(calls[0]).toMatchObject({
      format: "markdown",
      content: "full",
      includeLinks: false,
      includeMetadata: true
    });
  });

  it("resolves npm package pages to repository README when available", async () => {
    const calls: WebFetchRequest[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);

            if (params.url === "https://registry.npmjs.org/chalk/latest") {
              return {
                content: JSON.stringify({
                  name: "chalk",
                  version: "5.6.2",
                  description: "Terminal string styling done right",
                  license: "MIT",
                  repository: { type: "git", url: "git+https://github.com/chalk/chalk.git" }
                }),
                status: 200,
                content_type: "application/json",
                truncated: false
              };
            }

            if (
              params.url ===
              "https://raw.githubusercontent.com/chalk/chalk/main/readme.md"
            ) {
              return {
                content: "## Install\n\n```bash\nnpm install chalk\n```",
                status: 200,
                content_type: "text/markdown",
                truncated: false
              };
            }

            return {
              content: "",
              status: 404,
              content_type: "text/plain",
              truncated: false
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const result = await tool.execute({
      url: "https://www.npmjs.com/package/chalk",
      prompt: "Extract install and usage"
    });

    expect(result.content_type).toBe("text/markdown");
    expect(result.content).toContain("# chalk");
    expect(result.content).toContain("Repositorio: https://github.com/chalk/chalk");
    expect(result.content).toContain("## README");
    expect(result.content).toContain("npm install chalk");
    expect(result.applied_max_chars).toBe(80000);

    expect(calls[0]?.url).toBe("https://registry.npmjs.org/chalk/latest");
    expect(calls.some(c => c.url.includes("raw.githubusercontent.com/chalk/chalk"))).toBe(
      true
    );
  });

  it("continues past failing README candidates instead of orphaning the rest", async () => {
    const seen: string[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            const url = params.url ?? "";
            seen.push(url);
            if (url === "https://registry.npmjs.org/chalk/latest") {
              return {
                content: JSON.stringify({
                  name: "chalk",
                  repository: { type: "git", url: "git+https://github.com/chalk/chalk.git" }
                }),
                status: 200,
                content_type: "application/json",
                truncated: false
              };
            }
            if (url.endsWith("/main/readme.md")) {
              throw new Error("timeout simulado");
            }
            if (url.endsWith("/main/README.md")) {
              return {
                content: "# chalk readme",
                status: 200,
                content_type: "text/markdown",
                truncated: false
              };
            }
            return { content: "", status: 404, content_type: "text/plain", truncated: false };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const result = await tool.execute({ url: "https://www.npmjs.com/package/chalk" });

    expect(result.content).toContain("# chalk readme");
    expect(seen.some((url) => url.endsWith("/main/readme.md"))).toBe(true);
    expect(seen.some((url) => url.endsWith("/main/README.md"))).toBe(true);
  });

  it("degrades to the generic fetch when the npm metadata sub-fetch hits a proxy 5xx", async () => {
    const seen: string[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            seen.push(params.url ?? params.cursor ?? "");
            if (params.url === "https://registry.npmjs.org/chalk/latest") {
              throw new EnriProxyHttpError("El fetch web falló (HTTP 502).", 502, {}, "");
            }
            return {
              content: "página npm genérica",
              status: 200,
              content_type: "text/html",
              truncated: false,
              url: params.url
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const result = (await tool.execute({ url: "https://www.npmjs.com/package/chalk" })) as WebFetchToolResult;

    expect(result.content).toBe("página npm genérica");
    expect(seen).toContain("https://www.npmjs.com/package/chalk");
  });

  it("degrades to the generic fetch when the npm metadata sub-fetch times out", async () => {
    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            if (params.url === "https://registry.npmjs.org/chalk/latest") {
              throw new Error("La petición expiró después de 20000ms");
            }
            return {
              content: "vía genérica",
              status: 200,
              content_type: "text/html",
              truncated: false
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const result = (await tool.execute({ url: "https://www.npmjs.com/package/chalk" })) as WebFetchToolResult;
    expect(result.content).toBe("vía genérica");
  });

  it("rethrows npm metadata failures when the caller already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (): Promise<WebFetchResponse> => {
            throw new EnriProxyHttpError("El fetch web falló (HTTP 502).", 502, {}, "");
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    await expect(
      tool.execute({ url: "https://www.npmjs.com/package/chalk" }, controller.signal)
    ).rejects.toThrow(/502/);
  });

  it("propagates the winning README cursor and total_chars to the npm result", async () => {
    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            if (params.url === "https://registry.npmjs.org/chalk/latest") {
              return {
                content: JSON.stringify({
                  name: "chalk",
                  repository: { type: "git", url: "git+https://github.com/chalk/chalk.git" }
                }),
                status: 200,
                content_type: "application/json",
                truncated: false
              };
            }
            if (params.url === "https://raw.githubusercontent.com/chalk/chalk/main/README.md") {
              return {
                content: "# readme largo",
                status: 200,
                content_type: "text/markdown",
                truncated: true,
                cursor: "123e4567-e89b-12d3-a456-426614174999",
                total_chars: 250000,
                has_more: true
              };
            }
            return { content: "", status: 404, content_type: "text/plain", truncated: false };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 20000
    });

    const result = (await tool.execute({ url: "https://www.npmjs.com/package/chalk" })) as WebFetchToolResult;

    expect(result.truncated).toBe(true);
    expect(result.cursor).toBe("123e4567-e89b-12d3-a456-426614174999");
    expect(result.total_chars).toBe(250000);
    expect(result.has_more).toBe(true);
    expect(tool.formatOutput(result)).toContain('cursor="123e4567-e89b-12d3-a456-426614174999"');
  });

  it("sends action delete with cursor and formats both outcomes in Spanish", async () => {
    const calls: WebFetchRequest[] = [];
    let deleted = true;

    const tool = new WebFetchTool({
      createClient: () => {
        const fake = {
          webFetch: async (params: WebFetchRequest): Promise<unknown> => {
            calls.push(params);
            if ("action" in params && params.action === "delete") {
              return { deleted, cursor: params.cursor };
            }
            return { content: "", status: 200, content_type: "application/json", truncated: false };
          }
        };
        return fake as unknown as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 80000
    });

    const cursor = "123e4567-e89b-12d3-a456-426614174000";
    const params = tool.parseParams({ action: "delete", cursor });
    expect(params.action).toBe("delete");

    const hit = (await tool.execute(params)) as WebFetchToolDeleteResult;
    expect(calls[0]).toMatchObject({ cursor, action: "delete" });
    expect(hit).toMatchObject({ deleted: true, cursor });
    expect(tool.formatOutput(hit)).toContain("Cursor eliminado.");

    deleted = false;
    const miss = (await tool.execute({ action: "delete", cursor })) as WebFetchToolDeleteResult;
    expect(miss.deleted).toBe(false);
    expect(tool.formatOutput(miss)).toContain("Cursor no encontrado o expirado.");
  });

  it("fans out concurrent cursor reads for ranges after a truncated first read", async () => {
    const calls: WebFetchRequest[] = [];
    const cursor = "123e4567-e89b-12d3-a456-426614174000";

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            if ("url" in params) {
              return {
                content: "a".repeat(4000),
                status: 200,
                content_type: "text/plain",
                truncated: true,
                url: params.url,
                cursor,
                total_chars: 400000,
                has_more: true
              };
            }
            const offset = params.offsetChars ?? 0;
            return {
              content: `slice@${offset}`,
              status: 200,
              content_type: "text/plain",
              truncated: offset + 100000 >= 400000,
              cursor,
              offset_chars: offset,
              limit_chars: params.limitChars,
              total_chars: 400000
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      url: "https://example.com/big",
      ranges: [
        { offsetChars: 0, limitChars: 5000 },
        { offsetChars: 120000, limitChars: 5000 },
        { offsetChars: 350000 }
      ]
    })) as WebFetchToolRangesResult;

    const cursorCalls = calls.filter((call) => "cursor" in call && !("url" in call));
    expect(cursorCalls).toHaveLength(3);
    expect(result.range_applied).toBe(true);
    expect(result.range_count).toBe(3);
    expect(result.cursor).toBe(cursor);
    expect(result.ranges.map((slice) => slice.content)).toEqual([
      "slice@0",
      "slice@120000",
      "slice@350000"
    ]);
    expect(result.ranges[1]?.offset_chars).toBe(120000);
    expect(result.ranges[1]?.limit_chars).toBe(5000);
    expect(result.range_hint).toContain(cursor);
    const text = tool.formatOutput(result);
    expect(text).toContain("[Rango 2] offset_chars=120000");
    expect(text).toContain("slice@120000");
  });

  it("applies ranges locally when the first read returns no cursor", async () => {
    const calls: WebFetchRequest[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            return {
              content: "0123456789".repeat(100),
              status: 200,
              content_type: "text/plain",
              truncated: false,
              url: params.url
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      url: "https://example.com/doc",
      ranges: [
        { offsetChars: 10, limitChars: 5 },
        { offsetChars: 995 }
      ]
    })) as WebFetchToolRangesResult;

    expect(calls).toHaveLength(1);
    expect(result.range_applied).toBe(true);
    expect(result.ranges[0]?.content).toBe("01234");
    expect(result.ranges[0]?.truncated).toBe(false);
    expect(result.ranges[1]?.offset_chars).toBe(995);
    expect(result.ranges[1]?.content.length).toBe(5);
    expect(result.ranges[1]?.truncated).toBe(true);
    expect(result.range_hint).toContain("localmente");
  });

  it("reads grouped ranges directly when a cursor is provided", async () => {
    const calls: WebFetchRequest[] = [];
    const cursor = "123e4567-e89b-12d3-a456-426614174000";

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            return {
              content: `chunk@${params.offsetChars ?? 0}`,
              status: 200,
              content_type: "text/plain",
              truncated: false,
              cursor
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      cursor,
      ranges: [{ offsetChars: 7, limitChars: 3 }]
    })) as WebFetchToolRangesResult;

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ cursor, offsetChars: 7, limitChars: 3 });
    expect(result.ranges[0]?.content).toBe("chunk@7");
  });

  it("slices url-mode offset/limit locally over the returned content", async () => {
    const calls: WebFetchRequest[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            calls.push(params);
            return {
              content: "0123456789".repeat(4000), // 40 000 chars
              status: 200,
              content_type: "text/plain",
              truncated: false,
              url: params.url
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      url: "https://example.com/doc",
      offsetChars: 10_000,
      limitChars: 500
    })) as WebFetchToolRangesResult;

    // The first read asks for a capture that reaches the window end even
    // beyond the call budget (10 000 + 500), then slices locally.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.maxChars).toBe(10_500);
    expect(result.range_applied).toBe(true);
    expect(result.range_count).toBe(1);
    expect(result.ranges[0]?.offset_chars).toBe(10_000);
    expect(result.ranges[0]?.limit_chars).toBe(500);
    expect(result.ranges[0]?.content).toBe("0123456789".repeat(4000).slice(10_000, 10_500));
    expect(result.ranges[0]?.truncated).toBe(false);
  });

  it("uses the call max_chars as the default slice length on both local-range routes", async () => {
    const createFakeClient = (
      calls: WebFetchRequest[],
      respond: (params: WebFetchRequest) => WebFetchResponse
    ): EnriProxyClient => {
      const fake: Pick<EnriProxyClient, "webFetch"> = {
        webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
          calls.push(params);
          return respond(params);
        }
      };
      return fake as EnriProxyClient;
    };

    // Plain route: the capture budget is raised to the furthest range end
    // (125 000), but a range without limit_chars still slices the call
    // budget (4 000), matching the documented "omitido usa max_chars".
    const plainCalls: WebFetchRequest[] = [];
    const plainTool = new WebFetchTool({
      createClient: () =>
        createFakeClient(plainCalls, (): WebFetchResponse => ({
          content: "x".repeat(100_000),
          status: 200,
          content_type: "text/plain",
          truncated: false,
          url: "https://example.com/plain"
        })),
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const plain = (await plainTool.execute({
      url: "https://example.com/plain",
      ranges: [
        { offsetChars: 120_000, limitChars: 5000 },
        { offsetChars: 0 }
      ]
    })) as WebFetchToolRangesResult;

    expect(plainCalls[0]?.maxChars).toBe(125_000);
    expect(plain.ranges[1]?.limit_chars).toBe(4000);
    expect(plain.ranges[1]?.content.length).toBe(4000);

    // npm route: same documented default for a limit-less range.
    const npmCalls: WebFetchRequest[] = [];
    const npmTool = new WebFetchTool({
      createClient: () =>
        createFakeClient(npmCalls, (params: WebFetchRequest): WebFetchResponse => {
          if (params.url === "https://registry.npmjs.org/chalk/latest") {
            return {
              content: JSON.stringify({
                name: "chalk",
                repository: { type: "git", url: "git+https://github.com/chalk/chalk.git" }
              }),
              status: 200,
              content_type: "application/json",
              truncated: false
            };
          }
          if (params.url === "https://raw.githubusercontent.com/chalk/chalk/main/README.md") {
            return {
              content: "r".repeat(50_000),
              status: 200,
              content_type: "text/markdown",
              truncated: false
            };
          }
          return { content: "", status: 404, content_type: "text/plain", truncated: false };
        }),
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const npm = (await npmTool.execute({
      url: "https://www.npmjs.com/package/chalk",
      ranges: [{ offsetChars: 0 }]
    })) as WebFetchToolRangesResult;

    expect(npm.ranges[0]?.limit_chars).toBe(4000);
    expect(npm.ranges[0]?.content.length).toBe(4000);
  });

  it("marks out-of-range local slices as empty with an honest note instead of truncated", async () => {
    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => ({
            content: "0123456789".repeat(100), // 1 000 chars
            status: 200,
            content_type: "text/plain",
            truncated: false,
            url: params.url
          })
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      url: "https://example.com/doc",
      ranges: [
        { offsetChars: 1500, limitChars: 100 },
        { offsetChars: 900, limitChars: 200 }
      ]
    })) as WebFetchToolRangesResult;

    expect(result.ranges[0]?.content).toBe("");
    expect(result.ranges[0]?.truncated).toBe(false);
    expect(result.ranges[0]?.note).toMatch(/fuera de la página devuelta \(1000 caracteres sin decoraciones\)/u);
    expect(tool.formatOutput(result)).toContain("[El offset queda fuera de la página devuelta");

    // A window that starts inside the content and hits its end keeps the
    // real truncation flag.
    expect(result.ranges[1]?.content.length).toBe(100);
    expect(result.ranges[1]?.truncated).toBe(true);
  });

  it("returns per-range Spanish error rows when one cursor slice fails and siblings succeed", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            if ((params as { offsetChars?: number }).offsetChars === 100) {
              throw new EnriProxyHttpError("El fetch web falló (HTTP 400).", 400, {}, "");
            }
            return {
              content: `chunk@${(params as { offsetChars?: number }).offsetChars ?? 0}`,
              status: 200,
              content_type: "text/plain",
              truncated: false,
              cursor
            };
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      cursor,
      ranges: [
        { offsetChars: 0, limitChars: 10 },
        { offsetChars: 100, limitChars: 10 },
        { offsetChars: 200, limitChars: 10 }
      ]
    })) as WebFetchToolRangesResult;

    expect(result.range_count).toBe(3);
    expect(result.ranges[0]?.content).toBe("chunk@0");
    expect(result.ranges[0]?.error).toBeUndefined();
    expect(result.ranges[1]?.content).toBe("");
    expect(result.ranges[1]?.error).toMatch(/Rango 2 falló: .*HTTP 400/u);
    expect(result.ranges[2]?.content).toBe("chunk@200");
    expect(result.truncated).toBe(false);
    const text = tool.formatOutput(result);
    expect(text).toContain("1 fallaron");
    expect(text).toContain("[Rango 2]");
    expect(text).toContain("Rango 2 falló");
  });

  it("cancels in-flight sibling slices when the proxy rejects the cursor", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (
            params: WebFetchRequest,
            signal?: AbortSignal
          ): Promise<WebFetchResponse> => {
            if ((params as { offsetChars?: number }).offsetChars === 0) {
              await new Promise((resolve): void => {
                setTimeout(resolve, 20);
              });
              throw new EnriProxyHttpError("El fetch web falló (HTTP 400).", 400, {}, "");
            }
            return await new Promise<WebFetchResponse>((_resolve, reject): void => {
              signal?.addEventListener("abort", (): void => {
                reject(new Error("La petición fue cancelada por el cliente."));
              });
            });
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      cursor,
      ranges: [
        { offsetChars: 0, limitChars: 10 },
        { offsetChars: 100, limitChars: 10 }
      ]
    })) as WebFetchToolRangesResult;

    expect(result.ranges[0]?.error).toMatch(/Rango 1 falló: .*HTTP 400/u);
    expect(result.ranges[1]?.error).toMatch(
      /Rango 2 falló: .*rechazó el cursor en otro rango/u
    );
  });

  it("rethrows caller cancellations from grouped ranges instead of returning error rows", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";
    const controller = new AbortController();

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: (
            _params: WebFetchRequest,
            signal?: AbortSignal
          ): Promise<WebFetchResponse> =>
            new Promise<WebFetchResponse>((_resolve, reject): void => {
              const rejectAborted = (): void => {
                reject(new Error("La petición fue cancelada por el cliente."));
              };
              if (signal?.aborted) {
                rejectAborted();
                return;
              }
              signal?.addEventListener("abort", rejectAborted, { once: true });
            })
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const pending = tool.execute(
      { cursor, ranges: [{ offsetChars: 0, limitChars: 10 }] },
      controller.signal
    );
    setTimeout((): void => {
      controller.abort();
    }, 10);

    await expect(pending).rejects.toThrow(/cancelada por el cliente/u);
  });

  it("passes next_offset_chars through and uses it in the pagination hint", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (): Promise<WebFetchResponse> => ({
            content: "a".repeat(20_000),
            status: 200,
            content_type: "text/plain",
            truncated: true,
            cursor,
            offset_chars: 0,
            limit_chars: 20_000,
            total_chars: 100_000,
            has_more: true,
            next_offset_chars: 20_000
          })
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({ cursor })) as WebFetchToolResult;

    expect(result.next_offset_chars).toBe(20_000);
    expect(tool.formatOutput(result)).toContain("offset_chars=20000");
  });

  it("keeps the proxy body diagnostic and wraps transport failures in Spanish error rows", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";

    const httpTool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (): Promise<WebFetchResponse> => {
            throw new EnriProxyHttpError(
              "El fetch web falló (HTTP 400).",
              400,
              {},
              JSON.stringify({ message: "Cursor no encontrado o expirado." })
            );
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const httpResult = (await httpTool.execute({
      cursor,
      ranges: [{ offsetChars: 0, limitChars: 10 }]
    })) as WebFetchToolRangesResult;
    expect(httpResult.ranges[0]?.error).toContain("HTTP 400");
    expect(httpResult.ranges[0]?.error).toContain("Cursor no encontrado o expirado");

    const transportTool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (): Promise<WebFetchResponse> => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:8787");
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const transportResult = (await transportTool.execute({
      cursor,
      ranges: [{ offsetChars: 0, limitChars: 10 }]
    })) as WebFetchToolRangesResult;
    expect(transportResult.ranges[0]?.error).toContain("fallo de red leyendo el rango");
    expect(transportResult.ranges[0]?.error).toContain("ECONNREFUSED");
  });

  it("switches the range hint when the exhausted capture was released early", async () => {
    const cursor = "123e4567-e89b-12d3-a456-426614174000";
    const deletions: number[] = [];

    const tool = new WebFetchTool({
      createClient: () => {
        const fake: Pick<EnriProxyClient, "webFetch"> = {
          webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
            if (params.action === "delete") {
              deletions.push(1);
              return {
                content: "",
                status: 200,
                content_type: "application/json",
                truncated: false,
                cursor,
                deleted: true
              } as unknown as WebFetchResponse;
            }
            return {
              content: "fin",
              status: 200,
              content_type: "text/plain",
              truncated: false,
              cursor,
              has_more: false
            } as WebFetchResponse;
          }
        };
        return fake as EnriProxyClient;
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 4000
    });

    const result = (await tool.execute({
      cursor,
      ranges: [
        { offsetChars: 0, limitChars: 10 },
        { offsetChars: 10, limitChars: 10 }
      ]
    })) as WebFetchToolRangesResult;

    await new Promise((resolve): void => {
      setTimeout(resolve, 10);
    });
    expect(deletions).toHaveLength(1);
    expect(result.range_hint).toContain("cursor quedó liberado");
    expect(result.range_hint).toContain("url original");
  });
});
