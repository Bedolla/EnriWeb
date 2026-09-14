import { describe, expect, it } from "vitest";

import type {
  EnriProxyClient,
  WebFetchRequest,
  WebFetchResponse
} from "../src/client/EnriProxyClient.js";
import {
  WebFetchTool,
  type WebFetchToolRangesResult,
  type WebFetchToolExecuteResult
} from "../src/tools/WebFetchTool.js";

/**
 * Creates one tool bound to a fake client capturing requests.
 *
 * @param calls - Request capture sink.
 * @param respond - Response builder per request.
 * @param defaultMaxChars - Documented default budget.
 * @returns Tool under test.
 */
function createTool(
  calls: WebFetchRequest[],
  respond: (params: WebFetchRequest) => Partial<WebFetchResponse>,
  defaultMaxChars: number = 200_000
): WebFetchTool {
  return new WebFetchTool({
    createClient: (): EnriProxyClient => {
      const fake: Pick<EnriProxyClient, "webFetch"> = {
        webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
          calls.push(params);
          return {
            content: "",
            status: 200,
            content_type: "text/plain",
            truncated: false,
            ...respond(params)
          } as WebFetchResponse;
        }
      };
      return fake as EnriProxyClient;
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    defaultMaxChars
  });
}

describe("web_fetch audit round 2 (MCP parity)", () => {
  it("uses the call max_chars as the default slice length for cursor+ranges", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls, (params: WebFetchRequest): Partial<WebFetchResponse> => ({
      content: "x".repeat(Number(params.limitChars ?? 0)),
      truncated: false,
      has_more: false
    }));

    const result: WebFetchToolExecuteResult = await tool.execute({
      cursor: "123e4567-e89b-12d3-a456-426614174000",
      ranges: [{ offset_chars: 3_000_000 }]
    });

    const rangeCalls: ReadonlyArray<WebFetchRequest> = calls.filter(
      (call: WebFetchRequest): boolean => call.cursor === "123e4567-e89b-12d3-a456-426614174000"
    );
    expect(rangeCalls.length).toBeGreaterThanOrEqual(1);
    for (const call of rangeCalls) {
      expect(call.limitChars ?? 0).toBeLessThanOrEqual(200_000);
    }
    expect((result as WebFetchToolRangesResult).range_applied).toBe(true);
  });

  it("releases an exhausted single-cursor capture best-effort", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls, (): Partial<WebFetchResponse> => ({
      content: "done",
      truncated: false,
      has_more: false
    }));

    await tool.execute({ cursor: "123e4567-e89b-12d3-a456-426614174000" });

    await new Promise<void>((resolve): void => {
      setTimeout((): void => resolve(), 10);
    });
    const deletes: ReadonlyArray<WebFetchRequest> = calls.filter(
      (call: WebFetchRequest): boolean => (call as { action?: string }).action === "delete"
    );
    expect(deletes).toHaveLength(1);
  });

  it("propagates cursor and total_chars through local grouped ranges", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls, (): Partial<WebFetchResponse> => ({
      content: "abcdefghij".repeat(20),
      truncated: false,
      cursor: "123e4567-e89b-12d3-a456-426614174000",
      total_chars: 200,
      has_more: false
    }));

    const result: WebFetchToolExecuteResult = await tool.execute({
      url: "https://example.com/registry",
      ranges: [{ offset_chars: 0, limit_chars: 50 }]
    });

    const ranges = result as WebFetchToolRangesResult;
    expect(ranges.range_applied).toBe(true);
    expect(ranges.cursor).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(ranges.total_chars).toBe(200);
  });

  it("caps the per-slice text preview while structuredContent keeps the full slices", () => {
    const tool = new WebFetchTool({
      createClient: (): EnriProxyClient => {
        throw new Error("not used");
      },
      defaultServerUrl: "http://127.0.0.1:8787",
      defaultApiKey: "test",
      defaultTimeoutMs: 1000,
      defaultMaxChars: 200_000
    });
    const result: WebFetchToolRangesResult = {
      range_applied: true,
      range_count: 2,
      ranges: [
        {
          index: 1,
          offset_chars: 0,
          limit_chars: 100_000,
          content: "a".repeat(100_000),
          status: 200,
          content_type: "text/plain",
          truncated: false
        },
        {
          index: 2,
          offset_chars: 100_000,
          limit_chars: 100_000,
          content: "b".repeat(100_000),
          status: 200,
          content_type: "text/plain",
          truncated: false
        }
      ],
      truncated: false,
      range_hint: "hint",
      url: "https://example.com/big"
    };
    const text: string = tool.formatOutput(result);
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("structuredContent.ranges[0]");
    expect(text).toContain("structuredContent.ranges[1]");
  });
});
