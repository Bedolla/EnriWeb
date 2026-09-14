import { describe, expect, it } from "vitest";
import * as fc from "fast-check";

import { parseWebFetchParams } from "../src/tools/WebFetchParamsParser.js";
import { WebSearchTool } from "../src/tools/WebSearchTool.js";
import { WebFetchRangesExecutor } from "../src/tools/WebFetchRangesExecutor.js";
import { sliceUtf8Safe, truncateUtf8Safe } from "../src/shared/Utf8SafeTextSlicer.js";
import { assertHttpUrl, optionalInt, optionalStringArray } from "../src/shared/validation.js";
import { MAX_TOOL_RANGES } from "../src/tools/WebFetchTool.js";

/**
 * Deterministic seed shared by every property in this battery so failures
 * are reproducible from the reported seed alone.
 */
const PROPERTY_SEED: number = 20260913;

/**
 * Arbitrary JSON-ish junk values for parser robustness.
 */
const arbitraryJson: fc.Arbitrary<unknown> = fc.anything({
  withBigInt: true,
  withBoxedValues: true,
  withDate: true,
  withMap: true,
  withSet: true,
  withTypedArray: true,
  withSparseArray: true,
});

/**
 * Arbitrary astral-heavy text mixing ASCII, BMP and surrogate pairs.
 */
const arbitraryText: fc.Arbitrary<string> = fc
  .array(fc.constantFrom("a", "é", "😀", "𝕏", "中", "\n"), { minLength: 0, maxLength: 400 })
  .map((parts: string[]): string => parts.join(""));

/**
 * Detects Spanish text (the model-facing error language of this MCP).
 *
 * @param message - Error message.
 * @returns True when the message carries Spanish characters or wording.
 */
function isSpanishMessage(message: string): boolean {
  return /[áéíóúñÁÉÍÓÚÑ¿¡]|inválido|positivo|requiere|esperaba|objeto|arreglo|cadena|número|rango|url|cursor/iu.test(
    message
  );
}

/**
 * Reports whether one string ends with an unpaired high surrogate.
 *
 * @param value - Text to inspect.
 * @returns True when the last unit is a high surrogate.
 */
function endsWithLoneHighSurrogate(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const last: number = value.charCodeAt(value.length - 1);
  return last >= 0xd800 && last < 0xdc00;
}

/**
 * Builds a WebSearchTool with a dummy client (parse-only usage).
 *
 * @returns Tool under test.
 */
function createSearchTool(): WebSearchTool {
  return new WebSearchTool({
    createClient: (): never => {
      throw new Error("not used");
    },
    defaultServerUrl: "http://127.0.0.1:8787",
    defaultApiKey: "test",
    defaultTimeoutMs: 1_000,
    defaultMaxResults: 10
  } as never);
}

describe("Web tools property tests (MCP plane)", (): void => {
  it("P1: web_fetch params parse to valid params or throw Spanish Errors, never TypeError/URIError", (): void => {
    fc.assert(
      fc.property(arbitraryJson, (raw): void => {
        try {
          const params = parseWebFetchParams(raw);
          expect(params.cursor === undefined || /^[0-9a-fA-F-]{36}$/u.test(params.cursor)).toBe(true);
          expect(params.url === undefined || /^https?:/u.test(params.url)).toBe(true);
          if (params.format !== undefined) {
            expect(["text", "markdown", "html"]).toContain(params.format);
          }
          if (params.content !== undefined) {
            expect(["main", "full"]).toContain(params.content);
          }
          if (params.maxChars !== undefined) {
            expect(params.maxChars).toBeGreaterThanOrEqual(1);
          }
          if (params.offsetChars !== undefined) {
            expect(params.offsetChars).toBeGreaterThanOrEqual(0);
          }
          if (params.limitChars === undefined || params.limitChars >= 1) {
            expect(true).toBe(true);
          } else {
            throw new Error("limit fuera de dominio");
          }
          if (params.ranges !== undefined) {
            expect(params.ranges.length).toBeLessThanOrEqual(MAX_TOOL_RANGES);
            for (const range of params.ranges) {
              expect(range.offsetChars).toBeGreaterThanOrEqual(0);
              expect(range.limitChars === undefined || range.limitChars >= 1).toBe(true);
            }
          }
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(TypeError);
          expect(error).not.toBeInstanceOf(URIError);
          expect(isSpanishMessage((error as Error).message)).toBe(true);
        }
      }),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );
  });

  it("P1: web_search params parse to valid params or throw Spanish Errors", (): void => {
    fc.assert(
      fc.property(arbitraryJson, (raw): void => {
        try {
          const params = createSearchTool().parseParams(raw);
          if (params.queries !== undefined) {
            expect(params.queries.length).toBeGreaterThanOrEqual(1);
            for (const query of params.queries) {
              expect(query.trim().length).toBeGreaterThan(0);
            }
          }
          if (params.recency !== undefined) {
            expect(["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"]).toContain(params.recency);
          }
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(error).not.toBeInstanceOf(TypeError);
          expect(isSpanishMessage((error as Error).message)).toBe(true);
        }
      }),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );
  });

  it("P2: mutated valid fetch bodies reject in Spanish (ranges overflow, bad budgets, bad cursor)", (): void => {
    fc.assert(
      fc.property(fc.integer({ min: MAX_TOOL_RANGES + 1, max: MAX_TOOL_RANGES + 30 }), (extra): void => {
        const ranges = Array.from({ length: extra }, (): Record<string, unknown> => ({ offset_chars: 0 }));
        expect((): void => {
          parseWebFetchParams({ url: "https://example.test", ranges });
        }).toThrow(/máximo de \d+ rangos/u);
      }),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );

    fc.assert(
      fc.property(fc.integer({ min: -100, max: 0 }), (badMax): void => {
        // AR-4 client policy: unusable budgets degrade to the documented
        // default instead of failing the call (parity with EnriCode).
        const parsed = parseWebFetchParams({ url: "https://example.test", max_chars: badMax });
        expect(parsed.maxChars).toBeUndefined();
      }),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );

    fc.assert(
      fc.property(
        fc
          .string({ minLength: 1, maxLength: 40 })
          .filter((c: string): boolean => c.trim().length > 0 && !/^[0-9a-fA-F-]{36}$/u.test(c.trim())),
        (badCursor): void => {
          expect((): void => {
            parseWebFetchParams({ cursor: badCursor });
          }).toThrow(/Cursor inválido|requiere/u);
        }
      ),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );
  });

  it("P4: the shared slicers are idempotent, budget-bounded and pair-safe", (): void => {
    fc.assert(
      fc.property(arbitraryText, fc.integer({ min: 0, max: 900 }), (text, budget): void => {
        const sliced = sliceUtf8Safe(text, 0, budget);
        expect(sliced.length).toBeLessThanOrEqual(Math.max(0, budget));
        expect(endsWithLoneHighSurrogate(sliced)).toBe(false);
        expect(sliceUtf8Safe(sliced, 0, budget)).toBe(sliced);

        const truncated = truncateUtf8Safe(text, budget);
        expect(truncated.length).toBeLessThanOrEqual(Math.max(0, budget));
        expect(endsWithLoneHighSurrogate(truncated)).toBe(false);
      }),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );
  });

  it("P5: validation helpers survive arbitrary input without non-Spanish throws", (): void => {
    fc.assert(
      fc.property(arbitraryJson, (raw): void => {
        try {
          assertHttpUrl(raw, "url");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(isSpanishMessage((error as Error).message)).toBe(true);
        }

        const parsed = optionalInt(raw);
        if (parsed !== undefined) {
          expect(Number.isInteger(parsed)).toBe(true);
        }

        try {
          optionalStringArray(raw, "dominios");
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          expect(isSpanishMessage((error as Error).message)).toBe(true);
        }
      }),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );
  });

  it("P6/P7: local range application stays in-domain, budget-honest and reduced-safe", (): void => {
    const executor = new WebFetchRangesExecutor();
    fc.assert(
      fc.property(
        arbitraryText,
        fc.array(
          fc.record({
            offset: fc.integer({ min: 0, max: 600 }),
            limit: fc.option(fc.integer({ min: 1, max: 200 }), { nil: undefined }),
          }),
          { minLength: 1, maxLength: MAX_TOOL_RANGES },
        ),
        fc.integer({ min: 50, max: 1_000 }),
        fc.boolean(),
        (content, rawRanges, maxChars, reduced): void => {
          const result = executor.applyLocalRangesToResult(
            {
              content,
              status: 200,
              content_type: "text/plain",
              truncated: false,
              url: "https://example.test/property",
              ...(reduced ? { cursor: "123e4567-e89b-12d3-a456-426614174000", total_chars: 99_999, reduced: true } : {}),
            } as never,
            rawRanges.map((range): { offsetChars: number; limitChars?: number } => ({
              offsetChars: range.offset,
              ...(range.limit !== undefined ? { limitChars: range.limit } : {}),
            })),
            maxChars
          );

          expect(result.range_count).toBe(rawRanges.length);
          for (const slice of result.ranges) {
            expect(endsWithLoneHighSurrogate(slice.content)).toBe(false);
            if (slice.error === undefined) {
              expect(slice.offset_chars).toBeGreaterThanOrEqual(0);
            }
          }
          if (reduced) {
            expect(result.cursor).toBeUndefined();
            expect(result.total_chars).toBeUndefined();
          }
        },
      ),
      { numRuns: 2_000, seed: PROPERTY_SEED },
    );
  });
});


describe("Web tools property tests R3 (MCP examples, INV3)", (): void => {
  it("P14: every declared inputSchema example parses successfully through the MCP parsers", async (): Promise<void> => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { EnriWebServer } = await import("../src/server/EnriWebServer.js");

    const webFetchTool = {
      parseParams: (raw: unknown): unknown => raw,
      execute: async (): Promise<unknown> => ({ url: "https://example.com", content: "ok" }),
      formatOutput: (): string => "formatted",
      getDefaultMaxChars: (): number => 80000
    } as unknown as ConstructorParameters<typeof EnriWebServer>[0]["webFetchTool"];
    const webSearchTool = {
      parseParams: (raw: unknown): unknown => raw,
      execute: async (): Promise<unknown> => ({ query: "q", results: [] }),
      formatOutput: (): string => "formatted"
    } as unknown as ConstructorParameters<typeof EnriWebServer>[0]["webSearchTool"];

    const server = new EnriWebServer({ name: "EnriWeb", version: "test", webSearchTool, webFetchTool });
    const client = new Client({ name: "probe", version: "test" }, { capabilities: {} });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const searchSchema = listed.tools.find((tool) => tool.name === "web_search")?.inputSchema as Record<string, unknown>;
      const fetchSchema = listed.tools.find((tool) => tool.name === "web_fetch")?.inputSchema as Record<string, unknown>;
      for (const schema of [searchSchema, fetchSchema]) {
        const examples: unknown = schema["examples"];
        if (!Array.isArray(examples) || examples.length === 0) {
          throw new Error("inputSchema sin examples");
        }
      }
      for (const example of searchSchema["examples"] as ReadonlyArray<Record<string, unknown>>) {
        expect((): unknown => createSearchTool().parseParams(example)).not.toThrow();
        const params = createSearchTool().parseParams(example);
        expect((params.queries ?? []).length + (params.query ? 1 : 0)).toBeGreaterThanOrEqual(1);
      }
      for (const example of fetchSchema["examples"] as ReadonlyArray<Record<string, unknown>>) {
        expect((): unknown => parseWebFetchParams(example)).not.toThrow();
      }
    } finally {
      await client.close();
    }
  });
});
