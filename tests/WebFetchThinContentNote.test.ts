import { describe, expect, it } from "vitest";

import { WebFetchToolTextFormatter } from "../src/tools/WebFetchToolTextFormatter.js";
import type { WebFetchToolResult } from "../src/tools/WebFetchTool.js";

function baseResult(overrides: Partial<WebFetchToolResult> = {}): WebFetchToolResult {
  return {
    content: "hello world",
    status: 200,
    content_type: "text/plain",
    truncated: false,
    url: "https://public.example.com/page",
    ...overrides
  };
}

describe("WebFetchToolTextFormatter thin-content note", () => {
  it("coaches screenshot analyze on thin text without visual material", () => {
    const text = WebFetchToolTextFormatter.format(
      baseResult({ content: "tiny", screenshot_status: "skipped", screenshot_reason: "auto_rich_text" })
    );
    expect(text).toContain('screenshot="analyze"');
    expect(text).toContain("Texto mínimo");
  });

  it("stays silent for rich extractions", () => {
    const text = WebFetchToolTextFormatter.format(baseResult({ content: "x".repeat(5000) }));
    expect(text).not.toContain("Texto mínimo");
  });

  it("stays silent when image blocks or analysis already traveled", () => {
    const captured = WebFetchToolTextFormatter.format(
      baseResult({
        content: "tiny",
        screenshot_status: "captured",
        screenshots: [{ mime_type: "image/webp", base64: "eA==", width: 100, height: 100, scroll_y: 0 }]
      })
    );
    expect(captured).not.toContain("Texto mínimo");

    const analyzed = WebFetchToolTextFormatter.format(
      baseResult({ content: "tiny", screenshot_status: "analyzed", screenshot_analyses: ["a page"] })
    );
    expect(analyzed).not.toContain("Texto mínimo");
  });

  it("stays silent for truncated, error, and binary results", () => {
    expect(
      WebFetchToolTextFormatter.format(baseResult({ content: "tiny", truncated: true })).includes("Texto mínimo")
    ).toBe(false);
    expect(
      WebFetchToolTextFormatter.format(baseResult({ content: "tiny", status: 404 })).includes("Texto mínimo")
    ).toBe(false);
    expect(
      WebFetchToolTextFormatter.format(
        baseResult({ content: "tiny", content_type: "application/pdf", status: 200 })
      ).includes("Texto mínimo")
    ).toBe(false);
  });
});
