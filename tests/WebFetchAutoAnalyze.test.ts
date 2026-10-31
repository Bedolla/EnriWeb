/**
 * Auto-analyze follow-up for `auto` screenshot reads.
 *
 * @remarks
 * Hosts and models without vision input never consume MCP image blocks, so
 * an `auto` read that captured segments must also attach the server-side
 * visual description as text. Locks the trigger scope (auto only, images
 * present, no analyses yet), the cursor re-delivery path, the plain
 * re-read path, and the degrade-to-original fallback.
 *
 * @module tests/WebFetchAutoAnalyze
 */

import { describe, expect, it } from "vitest";

import type { EnriProxyClient, WebFetchResponse } from "../src/client/EnriProxyClient.js";
import { WebFetchTool, type WebFetchToolResult } from "../src/tools/WebFetchTool.js";
import { WebFetchToolTextFormatter } from "../src/tools/WebFetchToolTextFormatter.js";

/**
 * One captured screenshot segment shared by the fixtures.
 */
const SHOT = { mime_type: "image/webp", base64: "eA==", width: 100, height: 100, scroll_y: 0 };

/**
 * Builds one fetch tool backed by a scripted stub client.
 *
 * @param first - First-read proxy response.
 * @param followUp - Follow-up response (or failure) for the second call.
 * @param calls - Sink recording every wire payload in order.
 * @param defaultScreenshotMode - Optional installation-level screenshot default.
 * @returns Tool instance.
 */
function buildTool(
  first: WebFetchResponse,
  followUp: WebFetchResponse | Error,
  calls: Array<Record<string, unknown>>,
  defaultScreenshotMode?: "auto" | "force" | "none" | "analyze"
): WebFetchTool {
  const stubClient = {
    webFetch: async (params: Record<string, unknown>): Promise<WebFetchResponse> => {
      calls.push(params);
      if (calls.length === 1) {
        return first;
      }
      if (followUp instanceof Error) {
        throw followUp;
      }
      return followUp;
    }
  } as unknown as EnriProxyClient;
  return new WebFetchTool({
    createClient: (): EnriProxyClient => stubClient,
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    defaultMaxChars: 80000,
    ...(defaultScreenshotMode !== undefined ? { defaultScreenshotMode } : {})
  });
}

/**
 * Reads one single-read result out of the execute union.
 *
 * @param value - Execute result.
 * @returns Single-read result.
 */
function asSingle(value: unknown): WebFetchToolResult {
  return value as WebFetchToolResult;
}

/**
 * Builds one thin captured response without analyses.
 *
 * @param extra - Extra fields merged over the base response.
 * @returns Captured response fixture.
 */
function captured(extra: Partial<WebFetchResponse> = {}): WebFetchResponse {
  return {
    content: "thin",
    status: 200,
    content_type: "text/plain",
    truncated: false,
    url: "https://example.test",
    screenshots: [SHOT],
    screenshot_status: "captured",
    screenshot_reason: "auto_thin_text",
    ...extra
  };
}

/**
 * Builds one analyses-only follow-up response.
 *
 * @returns Analyses response fixture.
 */
function analyzed(): WebFetchResponse {
  return {
    content: "thin",
    status: 200,
    content_type: "text/plain",
    truncated: false,
    url: "https://example.test",
    screenshot_status: "analyzed",
    screenshot_analyses: ["Una página con un botón grande."]
  };
}

describe("WebFetchTool auto-analyze follow-up", (): void => {
  it("re-reads with analyze and merges descriptions when auto captured images without a cursor", async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = buildTool(captured(), analyzed(), calls);
    const result = asSingle(await tool.execute({ url: "https://example.test" }, undefined));

    expect(calls.length).toBe(2);
    expect(calls[1]?.["screenshot"]).toBe("analyze");
    expect(calls[1]?.["url"]).toBe("https://example.test");
    expect("cursor" in (calls[1] ?? {})).toBe(false);
    expect(result.screenshots?.length).toBe(1);
    expect(result.screenshot_analyses).toEqual(["Una página con un botón grande."]);
  });

  it("re-delivers through the cursor when the first response issued one", async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = buildTool(captured({ cursor: "c1", truncated: false }), analyzed(), calls);
    const result = asSingle(await tool.execute({ url: "https://example.test" }, undefined));

    expect(calls.length).toBe(2);
    expect(calls[1]?.["cursor"]).toBe("c1");
    expect(calls[1]?.["screenshot"]).toBe("analyze");
    expect("url" in (calls[1] ?? {})).toBe(false);
    expect(result.screenshot_analyses).toEqual(["Una página con un botón grande."]);
  });

  it("leaves explicit force reads untouched (images only, no second call)", async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = buildTool(captured(), analyzed(), calls);
    const result = asSingle(await tool.execute({ url: "https://example.test", screenshot: "force" }, undefined));

    expect(calls.length).toBe(1);
    expect(result.screenshot_analyses).toBeUndefined();
    expect(result.screenshots?.length).toBe(1);
  });

  it("skips the follow-up when analyses already traveled", async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const first = captured({ screenshot_analyses: ["Ya descrita."] });
    const tool = buildTool(first, analyzed(), calls);
    const result = asSingle(await tool.execute({ url: "https://example.test", screenshot: "analyze" }, undefined));

    expect(calls.length).toBe(1);
    expect(result.screenshot_analyses).toEqual(["Ya descrita."]);
  });

  it("honors the installation-level analyze default without a second call", async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const first = captured({ screenshot_analyses: ["Ya descrita."] });
    const tool = buildTool(first, analyzed(), calls, "analyze");
    const result = asSingle(await tool.execute({ url: "https://example.test" }, undefined));

    expect(calls[0]?.["screenshot"]).toBe("analyze");
    expect(calls.length).toBe(1);
    expect(result.screenshot_analyses).toEqual(["Ya descrita."]);
  });

  it("makes a single call when nothing was captured", async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const plain: WebFetchResponse = {
      content: "rich text",
      status: 200,
      content_type: "text/plain",
      truncated: false,
      url: "https://example.test",
      screenshot_status: "skipped",
      screenshot_reason: "auto_rich_text"
    };
    const tool = buildTool(plain, analyzed(), calls);
    const result = asSingle(await tool.execute({ url: "https://example.test" }, undefined));

    expect(calls.length).toBe(1);
    expect(result.screenshot_analyses).toBeUndefined();
  });

  it("degrades to the original result when the follow-up fails", async (): Promise<void> => {
    const calls: Array<Record<string, unknown>> = [];
    const tool = buildTool(captured(), new Error("vision down"), calls);
    const result = asSingle(await tool.execute({ url: "https://example.test" }, undefined));

    expect(calls.length).toBe(2);
    expect(result.screenshots?.length).toBe(1);
    expect(result.screenshot_analyses).toBeUndefined();
  });

  it("renders images and server-side descriptions together as text", (): void => {
    const text = WebFetchToolTextFormatter.format(
      captured({ screenshot_analyses: ["Una página con un botón grande."] })
    );
    expect(text).toContain("Capturas de pantalla");
    expect(text).toContain("Análisis visual de la página");
    expect(text).toContain("Una página con un botón grande.");
  });
});
