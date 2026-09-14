import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { EnriWebServer } from "../src/server/EnriWebServer.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { WebFetchTool } from "../src/tools/WebFetchTool.js";
import { MAX_ANCHOR_CHARS } from "../src/tools/WebFetchTool.js";
import { MAX_SEARCH_PROMPT_CHARS } from "../src/tools/WebSearchTool.js";
import { parseWebFetchParams } from "../src/tools/WebFetchParamsParser.js";

/**
 * Deterministic seed shared by every property in this battery.
 */
const PROPERTY_SEED: number = 20260914;

/**
 * Fake fetch tool used only to boot the server and list its real schemas.
 */
function fakeFetchTool(): WebFetchTool {
  return {
    parseParams: (raw: unknown): unknown => raw,
    execute: async (): Promise<unknown> => ({ url: "https://example.com", content: "ok" }),
    formatOutput: (): string => "formatted",
    getDefaultMaxChars: (): number => 80000
  } as unknown as WebFetchTool;
}

/**
 * Boots one in-memory server and returns its listed tools plus a closer.
 *
 * @returns Listed MCP tools and a cleanup callback.
 */
async function listServerTools(): Promise<{ tools: Tool[]; close: () => Promise<void> }> {
  const server = new EnriWebServer({
    name: "EnriWeb",
    version: "test",
    webSearchTool: {
      parseParams: (raw: unknown): unknown => raw,
      execute: async (): Promise<unknown> => ({ query: "q", results: [] }),
      formatOutput: (): string => "formatted"
    } as unknown as import("../src/tools/WebSearchTool.js").WebSearchTool,
    webFetchTool: fakeFetchTool()
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "test" }, { capabilities: {} });
  await client.connect(clientTransport);
  const listed = await client.listTools();
  const close = async (): Promise<void> => {
    await client.close();
  };
  return { tools: listed.tools as Tool[], close };
}

/**
 * Builds one valid string for a JSON-schema string property.
 *
 * @param property - Schema property record.
 * @returns Arbitrary producing schema-valid strings.
 */
function schemaStringArbitrary(property: Record<string, unknown>): fc.Arbitrary<string> {
  const enumValues: unknown = property["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    return fc.constantFrom(...(enumValues as string[]));
  }
  if (property["format"] === "uri" || property["description"]?.toString().includes("URL")) {
    return fc.webUrl();
  }
  const minLength: number = typeof property["minLength"] === "number" ? property["minLength"] : 0;
  const maxLength: number = typeof property["maxLength"] === "number" ? property["maxLength"] : 80;
  return fc.string({ minLength: Math.min(minLength, 60), maxLength: Math.max(minLength, Math.min(maxLength, 80)) });
}

/**
 * Builds one valid UUID-shaped string (cursor fields use prose + regex, not
 * format hints, so the generator stays UUID-aware for known cursor keys).
 *
 * @returns Arbitrary producing UUID strings.
 */
const uuidArbitrary: fc.Arbitrary<string> = fc.uuid();

/**
 * Generates a schema-valid value for one JSON-schema property.
 *
 * @param key - Property key (used for cursor/uuid awareness).
 * @param property - Schema property record.
 * @returns Arbitrary producing schema-valid values.
 */
function schemaValueArbitrary(key: string, property: Record<string, unknown>): fc.Arbitrary<unknown> {
  const type: unknown = property["type"];
  if (type === "string") {
    if (key === "cursor") {
      return uuidArbitrary;
    }
    return schemaStringArbitrary(property);
  }
  if (type === "number" || type === "integer") {
    const minimum: number = typeof property["minimum"] === "number" ? property["minimum"] : 0;
    const maximum: number = typeof property["maximum"] === "number" ? property["maximum"] : minimum + 50_000;
    return fc.integer({ min: minimum, max: Math.max(minimum, maximum) });
  }
  if (type === "boolean") {
    return fc.boolean();
  }
  if (type === "object") {
    const nested: Record<string, unknown> = (property["properties"] ?? {}) as Record<string, unknown>;
    const nestedKeys: ReadonlyArray<string> = Object.keys(nested);
    if (nestedKeys.length === 0) {
      return fc.constant({});
    }
    return fc
      .uniqueArray(fc.constantFrom(...nestedKeys), { minLength: 1, maxLength: nestedKeys.length })
      .chain((chosen: ReadonlyArray<string>): fc.Arbitrary<Record<string, unknown>> => {
        const builders: ReadonlyArray<fc.Arbitrary<[string, unknown]>> = chosen.map(
          (key: string): fc.Arbitrary<[string, unknown]> =>
            schemaValueArbitrary(key, (nested[key] ?? {}) as Record<string, unknown>).map(
              (value: unknown): [string, unknown] => [key, value]
            )
        );
        return fc
          .tuple(...builders)
          .map((pairs: ReadonlyArray<[string, unknown]>): Record<string, unknown> => {
            const record: Record<string, unknown> = {};
            for (const [key, value] of pairs) {
              record[key] = value;
            }
            return record;
          });
      });
  }
  if (type === "array") {
    const minItems: number = typeof property["minItems"] === "number" ? property["minItems"] : 0;
    const maxItems: number = typeof property["maxItems"] === "number" ? property["maxItems"] : 4;
    const items: Record<string, unknown> = (property["items"] ?? {}) as Record<string, unknown>;
    if (typeof items["type"] === "string") {
      return fc.array(schemaValueArbitrary("item", items), {
        minLength: Math.min(minItems, maxItems),
        maxLength: maxItems
      });
    }
    return fc.array(fc.string({ minLength: 1, maxLength: 12 }), {
      minLength: Math.min(minItems, maxItems),
      maxLength: maxItems
    });
  }
  return fc.constantFrom(null);
}

/**
 * Generates one schema-valid object for a tool inputSchema honoring its
 * `anyOf` required alternatives and property constraints.
 *
 * @param schema - Tool inputSchema.
 * @returns Arbitrary producing schema-valid argument objects.
 */
function schemaObjectArbitrary(schema: Record<string, unknown>): fc.Arbitrary<Record<string, unknown>> {
  const properties: Record<string, unknown> = (schema["properties"] ?? {}) as Record<string, unknown>;
  const anyOf: unknown = schema["anyOf"];
  const requiredAlternatives: ReadonlyArray<Record<string, unknown>> = Array.isArray(anyOf)
    ? (anyOf as ReadonlyArray<Record<string, unknown>>)
    : [];
  const alternativeIndex: fc.Arbitrary<number> = requiredAlternatives.length > 0
    ? fc.nat({ max: requiredAlternatives.length - 1 })
    : fc.constant(0);

  return alternativeIndex.chain((chosen: number): fc.Arbitrary<Record<string, unknown>> => {
    const required: ReadonlyArray<string> = requiredAlternatives.length > 0
      ? ((requiredAlternatives[chosen]?.["required"] as ReadonlyArray<string> | undefined) ?? [])
      : [];
    const optionalKeys: ReadonlyArray<string> = Object.keys(properties).filter(
      (key: string): boolean =>
        !required.includes(key) &&
        // `action` carries a cross-field dependency (delete requires
        // cursor) that JSON Schema cannot express; generating it blindly
        // produces schema-valid-but-parser-invalid inputs. Excluded from
        // the generator with that documented reason.
        key !== "action"
    );
    return fc
      .uniqueArray(fc.constantFrom(...optionalKeys), { maxLength: Math.min(optionalKeys.length, 4) })
      .chain((extras: ReadonlyArray<string>): fc.Arbitrary<Record<string, unknown>> => {
        const keys: ReadonlyArray<string> = [...required, ...extras];
        const builders: ReadonlyArray<fc.Arbitrary<[string, unknown]>> = keys.map(
          (key: string): fc.Arbitrary<[string, unknown]> =>
            schemaValueArbitrary(key, (properties[key] ?? {}) as Record<string, unknown>).map(
              (value: unknown): [string, unknown] => [key, value]
            )
        );
        return fc
          .tuple(...builders)
          .map((pairs: ReadonlyArray<[string, unknown]>): Record<string, unknown> => {
            const input: Record<string, unknown> = {};
            for (const [key, value] of pairs) {
              input[key] = value;
            }
            return input;
          });
      });
  });
}

describe("Web tools MCP property tests round 4 (schema plane, INV3/INV4)", (): void => {
  it("P-INV3: inputs generated FROM the published web_fetch inputSchema parse successfully", async (): Promise<void> => {
    const { tools, close } = await listServerTools();
    try {
      const fetchTool: Tool | undefined = tools.find((tool: Tool): boolean => tool.name === "web_fetch");
      expect(fetchTool).toBeDefined();
      const schema: Record<string, unknown> = (fetchTool?.inputSchema ?? {}) as Record<string, unknown>;
      const arbitrary = schemaObjectArbitrary(schema);
      await fc.assert(
        fc.asyncProperty(arbitrary, async (input: Record<string, unknown>): Promise<void> => {
          const params = parseWebFetchParams(input);
          expect(params.cursor === undefined || params.cursor.length > 0).toBe(true);
          expect(params.format === undefined || ["text", "markdown", "html"].includes(params.format)).toBe(true);
          expect(params.content === undefined || ["main", "full"].includes(params.content)).toBe(true);
          if (params.anchor !== undefined) {
            expect(params.anchor.length).toBeLessThanOrEqual(MAX_ANCHOR_CHARS);
          }
        }),
        { numRuns: 2_000, seed: PROPERTY_SEED }
      );
    } finally {
      await close();
    }
  });

  it("P-INV4: the published maxLength bounds cite the imported constants (anchor 300, search_prompt 2000)", async (): Promise<void> => {
    const { tools, close } = await listServerTools();
    try {
      const fetchSchema: Record<string, unknown> = (
        tools.find((tool: Tool): boolean => tool.name === "web_fetch")?.inputSchema ?? {}
      ) as Record<string, unknown>;
      const searchSchema: Record<string, unknown> = (
        tools.find((tool: Tool): boolean => tool.name === "web_search")?.inputSchema ?? {}
      ) as Record<string, unknown>;
      const fetchProperties: Record<string, unknown> = (fetchSchema["properties"] ?? {}) as Record<string, unknown>;
      const searchProperties: Record<string, unknown> = (searchSchema["properties"] ?? {}) as Record<string, unknown>;
      const anchor: Record<string, unknown> = (fetchProperties["anchor"] ?? {}) as Record<string, unknown>;
      const searchPrompt: Record<string, unknown> = (searchProperties["search_prompt"] ?? {}) as Record<string, unknown>;

      expect(anchor["maxLength"]).toBe(MAX_ANCHOR_CHARS);
      expect(String(anchor["description"])).toContain(String(MAX_ANCHOR_CHARS));
      expect(searchPrompt["maxLength"]).toBe(MAX_SEARCH_PROMPT_CHARS);
      expect(String(searchPrompt["description"])).toContain(String(MAX_SEARCH_PROMPT_CHARS));
    } finally {
      await close();
    }
  });

  it("P-INV4b: the anchor clamp stays pair-safe at the published boundary", (): void => {
    expect(MAX_ANCHOR_CHARS).toBe(300);
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("a", "é", "😀", "𝕏", "中", "#", " "), { minLength: 0, maxLength: 600 }),
        (units: ReadonlyArray<string>): void => {
          const raw: string = units.join("");
          const params = parseWebFetchParams({
            url: "https://example.com/doc",
            anchor: raw
          });
          if (params.anchor === undefined) {
            return;
          }
          expect(params.anchor.length).toBeLessThanOrEqual(MAX_ANCHOR_CHARS);
          const last: number = params.anchor.charCodeAt(params.anchor.length - 1);
          expect(last >= 0xd800 && last < 0xdc00).toBe(false);
          // The parser strips only the LEADING run of '#': a surviving '#'
          // after whitespace is legitimate content, so the invariant checks
          // budget and pair-safety, not '#'-freeness.
        }
      ),
      { numRuns: 2_000, seed: PROPERTY_SEED }
    );
  });
});
