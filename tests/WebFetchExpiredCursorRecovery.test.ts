import { describe, expect, it } from "vitest";

import {
  EnriProxyHttpError,
  isExpiredCursorError,
  isExpiredCursorMessageText
} from "../src/client/EnriProxyClient.js";
import type {
  EnriProxyClient,
  WebFetchRequest,
  WebFetchResponse
} from "../src/client/EnriProxyClient.js";
import {
  WebFetchTool,
  type WebFetchToolRangesResult,
  type WebFetchToolResult
} from "../src/tools/WebFetchTool.js";

const CURSOR = "123e4567-e89b-12d3-a456-426614174000";
const NEW_CURSOR = "223e4567-e89b-12d3-a456-426614174001";
const URL = "https://example.com/docs";

function expiredCursorFailure(): EnriProxyHttpError {
  return new EnriProxyHttpError(
    "El fetch web falló (HTTP 400).",
    400,
    {},
    "Cursor no encontrado o expirado."
  );
}

function makeTool(
  handler: (params: WebFetchRequest) => Promise<WebFetchResponse>,
  calls: WebFetchRequest[]
): WebFetchTool {
  return new WebFetchTool({
    createClient: () => {
      const fake: Pick<EnriProxyClient, "webFetch"> = {
        webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
          calls.push(params);
          return handler(params);
        }
      };
      return fake as EnriProxyClient;
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1000,
    defaultMaxChars: 80000
  });
}

function singleResponse(overrides: Partial<WebFetchResponse> = {}): WebFetchResponse {
  return {
    content: "fresh content body",
    status: 200,
    content_type: "text/html",
    truncated: false,
    url: URL,
    ...overrides
  };
}

describe("isExpiredCursorError", () => {
  it("matches 400 rejections carrying the cursor diagnostic", () => {
    expect(isExpiredCursorError(expiredCursorFailure())).toBe(true);
    expect(
      isExpiredCursorError(
        new EnriProxyHttpError("El fetch web falló (HTTP 400).", 400, {}, "Cursor not found or expired.")
      )
    ).toBe(true);
  });

  it("rejects other statuses, other bodies, and non-proxy failures", () => {
    expect(
      isExpiredCursorError(new EnriProxyHttpError("x", 400, {}, "bad request"))
    ).toBe(false);
    expect(
      isExpiredCursorError(
        new EnriProxyHttpError("x", 404, {}, "Cursor no encontrado o expirado.")
      )
    ).toBe(false);
    expect(isExpiredCursorError(new Error("Cursor no encontrado o expirado."))).toBe(false);
    expect(isExpiredCursorMessageText("todo bien")).toBe(false);
  });
});

describe("WebFetchTool expired-cursor recovery", () => {
  it("re-fetches the url when a single cursor read expires", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = makeTool(async (params: WebFetchRequest): Promise<WebFetchResponse> => {
      if ("cursor" in params) {
        throw expiredCursorFailure();
      }
      return singleResponse({ truncated: true, cursor: NEW_CURSOR, has_more: true });
    }, calls);

    const result = (await tool.execute(
      tool.parseParams({ cursor: CURSOR, url: URL })
    )) as WebFetchToolResult;

    expect(calls).toHaveLength(2);
    expect(result.content).toBe("fresh content body");
    expect(result.cursor).toBe(NEW_CURSOR);
    expect(result.recovered_from_expired_cursor).toBe(true);
    expect(result.recovery_note).toContain("cursor nuevo");
    const urlCall = calls[1];
    expect(urlCall).toMatchObject({ url: URL, format: "text", content: "main", includeLinks: true });
  });

  it("keeps the requested window when recovering a cursor read with offset/limit", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = makeTool(async (params: WebFetchRequest): Promise<WebFetchResponse> => {
      if ("cursor" in params) {
        throw expiredCursorFailure();
      }
      return singleResponse({ content: "0123456789abcdef", truncated: false });
    }, calls);

    const result = (await tool.execute(
      tool.parseParams({ cursor: CURSOR, url: URL, offset_chars: 4, limit_chars: 4 })
    )) as WebFetchToolRangesResult;

    expect(result.range_applied).toBe(true);
    expect(result.recovered_from_expired_cursor).toBe(true);
    expect(result.ranges).toHaveLength(1);
    expect(result.ranges[0]?.content).toBe("4567");
  });

  it("rethrows expired cursors without a recovery url", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = makeTool(async (): Promise<WebFetchResponse> => {
      throw expiredCursorFailure();
    }, calls);

    await expect(tool.execute(tool.parseParams({ cursor: CURSOR }))).rejects.toThrow(
      /HTTP 400/
    );
    expect(calls).toHaveLength(1);
  });

  it("never recovers non-cursor 400 failures even with a url present", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = makeTool(async (): Promise<WebFetchResponse> => {
      throw new EnriProxyHttpError("El fetch web falló (HTTP 400).", 400, {}, "solicitud inválida");
    }, calls);

    await expect(
      tool.execute(tool.parseParams({ cursor: CURSOR, url: URL }))
    ).rejects.toThrow(/HTTP 400/);
    expect(calls).toHaveLength(1);
  });

  it("recovers grouped cursor ranges when every slice reports a dead cursor", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = makeTool(async (params: WebFetchRequest): Promise<WebFetchResponse> => {
      if ("cursor" in params) {
        throw expiredCursorFailure();
      }
      return singleResponse({ content: "aaabbbccc", truncated: false });
    }, calls);

    const result = (await tool.execute(
      tool.parseParams({
        cursor: CURSOR,
        url: URL,
        ranges: [
          { offset_chars: 0, limit_chars: 3 },
          { offset_chars: 6, limit_chars: 3 }
        ]
      })
    )) as WebFetchToolRangesResult;

    expect(result.range_applied).toBe(true);
    expect(result.recovered_from_expired_cursor).toBe(true);
    expect(result.ranges.map((slice) => slice.content)).toEqual(["aaa", "ccc"]);
  });

  it("renders the recovery note in text output", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = makeTool(async (params: WebFetchRequest): Promise<WebFetchResponse> => {
      if ("cursor" in params) {
        throw expiredCursorFailure();
      }
      return singleResponse({ truncated: true, cursor: NEW_CURSOR, has_more: true });
    }, calls);

    const result = await tool.execute(tool.parseParams({ cursor: CURSOR, url: URL }));
    const text = tool.formatOutput(result);
    expect(text).toContain("Recuperación automática");
    expect(text).toContain("cursor nuevo");
  });
});
