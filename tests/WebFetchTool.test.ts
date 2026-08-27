import { describe, expect, it } from "vitest";

import type {
  EnriProxyClient,
  WebFetchRequest,
  WebFetchResponse
} from "../src/client/EnriProxyClient.js";
import { WebFetchTool } from "../src/tools/WebFetchTool.js";

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

  it("defaults format to undefined and rejects unknown formats", () => {
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

    const unknown = tool.parseParams({ url: "https://example.com", format: "pdf" });
    expect(unknown.format).toBeUndefined();

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
    expect(defaults.includeLinks).toBe(false);
    expect(defaults.includeMetadata).toBe(false);
    expect(defaults.anchor).toBeUndefined();

    const invalid = tool.parseParams({ url: "https://example.com/docs", content: "side" });
    expect(invalid.content).toBeUndefined();
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

    expect(() => tool.parseParams({ url: "https://example.com", max_chars: 0 })).toThrow(
      /max_chars/i
    );
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

  it("accepts limit=0 on URL fetch requests (treats as omitted)", () => {
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
      offset: 0,
      limit: 0
    });

    expect(params.url).toBe("https://example.com/docs");
    expect(params.offsetChars).toBeUndefined();
    expect(params.limitChars).toBeUndefined();
  });
});

describe("WebFetchTool.execute", () => {
  it("uses defaultMaxChars when max_chars is not provided", async () => {
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

    expect(calls[0]?.url).toBe("https://registry.npmjs.org/chalk/latest");
    expect(calls.some(c => c.url.includes("raw.githubusercontent.com/chalk/chalk"))).toBe(
      true
    );
  });
});
