import { describe, expect, it } from "vitest";

import type {
  EnriProxyClient,
  WebFetchRequest,
  WebFetchResponse
} from "../src/client/EnriProxyClient.js";
import {
  WebFetchTool,
  type WebFetchToolExecuteResult,
  type WebFetchToolRangesResult
} from "../src/tools/WebFetchTool.js";
import { WebFetchToolTextFormatter } from "../src/tools/WebFetchToolTextFormatter.js";
import { WebFetchRangesExecutor } from "../src/tools/WebFetchRangesExecutor.js";
import { WebFetchNpmProjection } from "../src/tools/WebFetchNpmProjection.js";
import { sliceUtf8Safe, truncateUtf8Safe } from "../src/shared/Utf8SafeTextSlicer.js";

/**
 * Creates one tool bound to a fake client capturing requests.
 *
 * @param calls - Request capture sink.
 * @param respond - Response builder per request.
 * @returns Tool under test.
 */
function createTool(
  calls: WebFetchRequest[],
  respond: (params: WebFetchRequest) => Partial<WebFetchResponse>
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
    defaultMaxChars: 200_000
  });
}

describe("web tools audit r2 (W4): MCP regressions", () => {
  it("does not release an out-of-range empty cursor read (W4-B1/N1)", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls, (): Partial<WebFetchResponse> => ({
      content: "",
      truncated: false,
      has_more: false,
      cursor: "123e4567-e89b-12d3-a456-426614174000",
      total_chars: 5_000,
      offset_chars: 5_000_000
    }));

    const result: WebFetchToolExecuteResult = await tool.execute({
      cursor: "123e4567-e89b-12d3-a456-426614174000",
      offsetChars: 5_000_000
    });

    const deleteCalls = calls.filter((call: WebFetchRequest): boolean => call.action === "delete");
    expect(deleteCalls).toHaveLength(0);
    expect(result.has_more).toBe(false);
    expect(result.cursor).toBeDefined();
    const text = WebFetchToolTextFormatter.format(result);
    expect(text).not.toContain("Lectura completa de la captura");
  });

  it("still releases a genuine read-through-end cursor page", async () => {
    const calls: WebFetchRequest[] = [];
    const tool = createTool(calls, (): Partial<WebFetchResponse> => ({
      content: "final",
      truncated: false,
      has_more: false,
      total_chars: 1_005,
      offset_chars: 1_000
    }));

    await tool.execute({ cursor: "123e4567-e89b-12d3-a456-426614174000", offsetChars: 1_000 });

    const deleteCalls = calls.filter((call: WebFetchRequest): boolean => call.action === "delete");
    expect(deleteCalls).toHaveLength(1);
  });

  it("never splits surrogate pairs in local range slices (W4-B2/N2)", async () => {
    const tool = createTool([], (): Partial<WebFetchResponse> => ({
      content: `${"a".repeat(9)}😀😀${"b".repeat(9)}`,
      truncated: false
    }));

    const result: WebFetchToolExecuteResult = await tool.execute({
      url: "https://example.test/emoji",
      offsetChars: 9,
      limitChars: 3,
      maxChars: 100
    });

    const ranges = result as WebFetchToolRangesResult;
    expect(ranges.range_applied).toBe(true);
    const slice = ranges.ranges[0];
    // offset 9 lands between the high and low surrogate of the first emoji:
    // the safe slice backs off and returns the complete pair. A trailing
    // LOW surrogate is legitimate only when preceded by its high surrogate.
    expect(slice.content).toBe("😀");
    const lastUnit: number = slice.content.charCodeAt(slice.content.length - 1);
    const prevUnit: number = slice.content.charCodeAt(slice.content.length - 2);
    const endsOnCompletePair: boolean = lastUnit >= 0xdc00 && prevUnit >= 0xd800 && prevUnit < 0xdc00;
    expect(lastUnit < 0xd800 || endsOnCompletePair).toBe(true);
  });

  it("keeps the npm projection trim and previews surrogate-safe", (): void => {
    const astral: string = `${"x".repeat(1_999)}😀😀`;
    expect(sliceUtf8Safe(astral, 0, 2_000).length).toBe(1_999);
    expect(truncateUtf8Safe(astral, 2_000).length).toBeLessThanOrEqual(2_000);
    const truncated: string = truncateUtf8Safe(astral, 4);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.charCodeAt(truncated.length - 2)).toBeLessThan(0xd800);
  });

  it("omits raw cursor/total_chars from reduced local-range results (W4-C1)", (): void => {
    const executor = new WebFetchRangesExecutor();
    const reduced = {
      content: "pack de extractos reordenado",
      status: 200,
      content_type: "text/html",
      truncated: true,
      url: "https://example.test/pack",
      cursor: "123e4567-e89b-12d3-a456-426614174000",
      total_chars: 50_000,
      reduced: true
    };

    const result = executor.applyLocalRangesToResult(
      reduced as never,
      [{ offsetChars: 0, limitChars: 5 }],
      100
    ) as WebFetchToolRangesResult;

    expect(result.range_applied).toBe(true);
    expect(result.cursor).toBeUndefined();
    expect(result.total_chars).toBeUndefined();
  });

  it("addresses local ranges to the undecorated page when the proxy reports bounds (r4)", (): void => {
    const executor = new WebFetchRangesExecutor();
    const page: string = `${"x".repeat(100)}FIN`;
    const header: string = "Obtenido https://example.test/doc (HTTP 404)";
    const footer: string = "(Contenido truncado)";
    const decorated = {
      content: `${header}\n\n${page}\n\n${footer}`,
      status: 404,
      content_type: "text/html",
      truncated: true,
      url: "https://example.test/doc",
      page_offset_chars: header.length + 2,
      page_chars: page.length
    };

    const result = executor.applyLocalRangesToResult(
      decorated as never,
      [{ offsetChars: 100, limitChars: 10 }],
      100
    ) as WebFetchToolRangesResult;

    expect(result.ranges[0]?.content).toBe("FIN");
    // The 10-char request overran the 103-char page by 7: an inside-start
    // window that hits the end is the documented real-truncation case
    // (parity with the client projector's truncated verdict for offset>0
    // windows), while has_more stays a pure more-content signal.
    expect(result.ranges[0]?.truncated).toBe(true);
  });

  it("rethrows caller aborts from the README pool instead of composing a result (W4-C2/N4)", async (): Promise<void> => {
    const controller = new AbortController();
    const projection = new WebFetchNpmProjection();
    const calls: string[] = [];
    const client: Pick<EnriProxyClient, "webFetch"> = {
      webFetch: async (params: WebFetchRequest): Promise<WebFetchResponse> => {
        calls.push(String(params.url ?? ""));
        if (params.url?.includes("registry.npmjs.org")) {
          return {
            content: JSON.stringify({
              name: "pkg",
              version: "1.0.0",
              repository: { type: "git", url: "https://github.com/owner/pkg" }
            }),
            status: 200,
            content_type: "application/json",
            truncated: false
          } as WebFetchResponse;
        }
        // Simulate a mid-flight caller cancellation on the README leg.
        controller.abort(new DOMException("cancelled", "AbortError"));
        throw controller.signal.reason;
      }
    };

    await expect(
      projection.tryExecuteNpmPackageFetch(
        { url: "https://www.npmjs.com/package/pkg" },
        client as EnriProxyClient,
        10_000,
        { format: "text", content: "main", includeLinks: true, includeMetadata: false },
        controller.signal
      )
    ).rejects.toThrow();
    expect(calls.some((url: string): boolean => url.includes("raw.githubusercontent.com"))).toBe(true);
  });
});
