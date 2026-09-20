/**
 * Regression coverage for the installation-level default screenshot mode
 * (`ENRIWEB_SCREENSHOT_MODE` → `WebFetchToolDeps.defaultScreenshotMode`):
 * when the host omits the parameter the default rides the wire, and an
 * explicit host parameter always wins. Built for clients whose provider
 * rejects image blocks inside tool results (OpenAI-compatible Chat
 * Completions) — `analyze` delivers server-side text instead of images.
 *
 * @module tests/WebFetchDefaultScreenshotMode
 */

import { describe, expect, it } from "vitest";

import type { EnriProxyClient } from "../src/client/EnriProxyClient.js";
import type { WebFetchRequest, WebFetchResponse } from "../src/client/EnriProxyClient.js";
import { WebFetchTool } from "../src/tools/WebFetchTool.js";
import type { WebFetchToolExecuteResult } from "../src/tools/WebFetchTool.js";

/**
 * Creates one tool bound to a fake client capturing requests, with a
 * configurable installation-level default screenshot mode.
 *
 * @param calls - Request capture sink.
 * @param defaultScreenshotMode - Installation default (absent = no default).
 * @returns Tool under test.
 */
function createTool(
  calls: WebFetchRequest[],
  defaultScreenshotMode?: "auto" | "force" | "none" | "analyze"
): WebFetchTool {
  return new WebFetchTool({
    createClient: (): EnriProxyClient => {
      const fake: Pick<EnriProxyClient, "webFetch"> = {
        webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
          calls.push(params);
          return {
            content: "PAGE",
            status: 200,
            content_type: "text/plain",
            truncated: false,
            has_more: false
          } as WebFetchResponse;
        }
      };
      return fake as EnriProxyClient;
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    defaultMaxChars: 200_000,
    defaultScreenshotMode
  });
}

describe("WebFetchDefaultScreenshotMode", (): void => {
  it("applies the installation default when the host omits the parameter", async (): Promise<void> => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls, "analyze");

    const result: WebFetchToolExecuteResult = await tool.execute({ url: "https://example.test/page" });

    expect(calls[0]?.screenshot).toBe("analyze");
    expect(result.screenshot_status).toBeUndefined();
  });

  it("lets an explicit host parameter win over the installation default", async (): Promise<void> => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls, "analyze");

    await tool.execute({ url: "https://example.test/page", screenshot: "none" });

    expect(calls[0]?.screenshot).toBe("none");
  });

  it("sends nothing when there is no default and the host omits the parameter", async (): Promise<void> => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls);

    await tool.execute({ url: "https://example.test/page" });

    expect("screenshot" in (calls[0] ?? {})).toBe(false);
  });
});
