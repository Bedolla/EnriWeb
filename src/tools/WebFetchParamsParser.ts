/**
 * Argument parsing for the web_fetch MCP tool.
 *
 * @remarks
 * Lenient for malformed optional values (they degrade to documented
 * defaults, matching the EnriCode client parser: unusable or out-of-domain
 * budgets fall back to the documented default instead of failing the call,
 * per the shared AR-4 client policy) but strict for structural mistakes
 * (broken ranges, unknown action without cursor, argument keys outside the
 * accepted set), which fail fast in
 * Spanish. Snake_case field names
 * are canonical; camelCase aliases (maxChars, offsetChars, limitChars,
 * includeLinks, includeMetadata) are accepted as fallbacks for parity with
 * the EnriCode tool surface. Extracted from {@link WebFetchTool} as a pure
 * function module.
 *
 * @module tools/WebFetchParamsParser
 */

import { assertHttpUrl, assertObject, optionalString, strictOptionalInt } from "../shared/validation.js";
import { sliceUtf8Safe } from "../shared/Utf8SafeTextSlicer.js";
import { MAX_ANCHOR_CHARS, MAX_TOOL_RANGES, type WebFetchToolParams, type WebFetchRangeSpec } from "./WebFetchTool.js";

/**
 * Argument keys accepted by the web_fetch tool (mirrors the fields this
 * parser actually reads; snake_case canonical plus camelCase aliases).
 */
const ACCEPTED_FETCH_PARAM_KEYS: readonly string[] = [
  "url",
  "cursor",
  "action",
  "prompt",
  "ranges",
  "offset",
  "offset_chars",
  "offsetChars",
  "limit",
  "limit_chars",
  "limitChars",
  "max_chars",
  "maxChars",
  "format",
  "content",
  "include_links",
  "includeLinks",
  "include_metadata",
  "includeMetadata",
  "anchor",
  "screenshot"
];

/**
 * Validates raw MCP tool arguments.
 *
 * @param raw - Raw tool arguments
 * @returns Validated parameters
 * @throws Error when a key outside the accepted set arrives (hallucinated
 *   parameters silently ignored would read as "request honored").
 */
export function parseWebFetchParams(raw: unknown): WebFetchToolParams {
  const obj = assertObject(raw, "arguments");

  // Unknown-parameter guard (web_search parity): any key outside the
  // accepted set rejects listing what IS accepted.
  const unknownParamKeys: string[] = Object.keys(obj).filter(
    (key: string): boolean => !ACCEPTED_FETCH_PARAM_KEYS.includes(key)
  );
  if (unknownParamKeys.length > 0) {
    throw new Error(
      `Parámetro no reconocido: ${unknownParamKeys.join(", ")}. Parámetros aceptados: url, cursor, action, prompt, ranges (array de {offsetChars, limitChars}), anchor, offset/offsetChars/offset_chars, limit/limitChars/limit_chars, maxChars/max_chars, format (text|markdown|html), content (main|full), includeLinks/include_links, includeMetadata/include_metadata, screenshot (auto|none|force|analyze).`
    );
  }

  const cursorRaw = optionalString(obj["cursor"]);
  const cursor = cursorRaw?.trim() ? cursorRaw.trim() : undefined;

  const urlRaw = optionalString(obj["url"]);
  const urlTrimmed = urlRaw?.trim() ? urlRaw.trim() : undefined;
  // A valid cursor always wins over a coexisting `url`: on cursor calls the
  // url degrades to an optional display label (invalid shapes are dropped
  // instead of hard-failing the whole call), while cursor-less calls keep
  // the strict http(s) validation.
  let url: string | undefined;
  if (cursor !== undefined) {
    url = urlTrimmed !== undefined && /^https?:\/\//iu.test(urlTrimmed) ? urlTrimmed : undefined;
  } else {
    url = urlTrimmed !== undefined ? assertHttpUrl(urlTrimmed, "url") : undefined;
  }

  if (!cursor && !url) {
    throw new Error("web_fetch requiere 'url' o 'cursor'.");
  }
  if (cursor && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u.test(cursor)) {
    throw new Error("Cursor inválido. Se esperaba un cursor devuelto por una llamada previa a web_fetch.");
  }

  const prompt = optionalString(obj["prompt"]);
  // max_chars is canonical; maxChars is the camelCase alias accepted for
  // parity with the EnriCode tool surface. Present-but-corrupt integers
  // (floats, "abc", booleans) REJECT with coaching — the legacy silent
  // floor/ignore made the model believe its window was honored.
  let maxChars =
    strictOptionalInt(obj["max_chars"], "max_chars/maxChars")
    ?? strictOptionalInt(obj["maxChars"], "max_chars/maxChars");
  // Strict enum parity with the proxy body parser and the EnriCode record:
  // a present, non-blank format/content outside the documented enum
  // REJECTS with the valid values instead of silently degrading to the
  // default (silent "xml"->text reads as "format honored").
  const formatRaw: unknown = obj["format"];
  if (formatRaw !== undefined && formatRaw !== null && !(typeof formatRaw === "string" && formatRaw.trim() === "")) {
    if (formatRaw !== "text" && formatRaw !== "markdown" && formatRaw !== "html") {
      const rendered: string = typeof formatRaw === "string" ? `"${formatRaw.trim()}"` : String(formatRaw);
      throw new Error(`format inválido: ${rendered}. Valores aceptados: text, markdown, html.`);
    }
  }
  const format: "text" | "markdown" | "html" | undefined =
    formatRaw === "markdown" || formatRaw === "text" || formatRaw === "html"
      ? (formatRaw as "text" | "markdown" | "html")
      : undefined;
  const contentRaw: unknown = obj["content"];
  if (contentRaw !== undefined && contentRaw !== null && !(typeof contentRaw === "string" && contentRaw.trim() === "")) {
    if (contentRaw !== "main" && contentRaw !== "full") {
      const rendered: string = typeof contentRaw === "string" ? `"${contentRaw.trim()}"` : String(contentRaw);
      throw new Error(`content inválido: ${rendered}. Valores aceptados: main, full.`);
    }
  }
  const content: "main" | "full" | undefined =
    contentRaw === "main" || contentRaw === "full" ? (contentRaw as "main" | "full") : undefined;
  const includeLinks: boolean | undefined =
    obj["include_links"] === true || obj["includeLinks"] === true
      ? true
      : obj["include_links"] === false || obj["includeLinks"] === false
        ? false
        : undefined;
  const includeMetadata: boolean | undefined =
    obj["include_metadata"] === true || obj["includeMetadata"] === true
      ? true
      : obj["include_metadata"] === false || obj["includeMetadata"] === false
        ? false
        : undefined;
  const anchorRaw = optionalString(obj["anchor"]);
  const anchorClean = anchorRaw ? sliceUtf8Safe(anchorRaw.trim().replace(/^#+/, "").trim(), 0, MAX_ANCHOR_CHARS) : "";
  const anchor = anchorClean ? anchorClean : undefined;
  const offsetCharsRaw =
    strictOptionalInt(obj["offset_chars"], "offset_chars/offsetChars/offset")
    ?? strictOptionalInt(obj["offsetChars"], "offset_chars/offsetChars/offset")
    ?? strictOptionalInt(obj["offset"], "offset_chars/offsetChars/offset");
  const limitCharsRaw =
    strictOptionalInt(obj["limit_chars"], "limit_chars/limitChars/limit")
    ?? strictOptionalInt(obj["limitChars"], "limit_chars/limitChars/limit")
    ?? strictOptionalInt(obj["limit"], "limit_chars/limitChars/limit");
  const action: "delete" | undefined = obj["action"] === "delete" ? "delete" : undefined;
  const ranges = parseRanges(obj["ranges"]);
  // Strict enum parity with the proxy body parser and the EnriCode record:
  // a present, non-blank screenshot mode outside the enum REJECTS with the
  // valid values (silent degrade read as "mode honored").
  const screenshotRaw: unknown = obj["screenshot"];
  if (
    screenshotRaw !== undefined
    && screenshotRaw !== null
    && !(typeof screenshotRaw === "string" && screenshotRaw.trim() === "")
  ) {
    if (
      screenshotRaw !== "auto"
      && screenshotRaw !== "force"
      && screenshotRaw !== "none"
      && screenshotRaw !== "analyze"
    ) {
      const rendered: string = typeof screenshotRaw === "string" ? `"${screenshotRaw.trim()}"` : String(screenshotRaw);
      throw new Error(`screenshot inválido: ${rendered}. Valores aceptados: auto, none, force, analyze (u omítelo para usar el default).`);
    }
  }
  const screenshot: "auto" | "force" | "none" | "analyze" | undefined =
    screenshotRaw === "auto" || screenshotRaw === "force" || screenshotRaw === "none" || screenshotRaw === "analyze"
      ? (screenshotRaw as "auto" | "force" | "none" | "analyze")
      : undefined;

  if (action === "delete" && !cursor) {
    throw new Error("action 'delete' requiere 'cursor'.");
  }
  // AR-4 client parity (EnriCode readOptionalPositiveInteger): a
  // non-positive or otherwise unusable budget degrades to the server
  // default instead of failing the call mid-task.
  if (maxChars !== undefined && maxChars < 1) {
    maxChars = undefined;
  }

  // offset/limit travel with cursor reads (server-side window over the
  // capture) and with url reads (local slice over the returned content,
  // matching EnriCode's first-read range semantics).
  // AR-4 client parity: negative offsets/limits degrade to the
  // documented defaults (no offset / no explicit limit).
  const offsetChars = offsetCharsRaw !== undefined && offsetCharsRaw >= 0 ? offsetCharsRaw : undefined;
  let limitChars: number | undefined = limitCharsRaw;

  if (limitChars !== undefined && limitChars <= 0) {
    limitChars = undefined;
  }

  return {
    url,
    cursor,
    prompt,
    maxChars,
    format,
    content,
    includeLinks,
    includeMetadata,
    anchor,
    offsetChars,
    limitChars,
    action,
    ranges,
    screenshot
  };
}

/**
 * Parses an optional `ranges` array of character windows.
 *
 * @param raw - Raw input
 * @returns Range specs, or undefined when absent/empty
 */
function parseRanges(raw: unknown): WebFetchRangeSpec[] | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!Array.isArray(raw)) {
    throw new Error("ranges debe ser un arreglo de objetos {offset_chars, limit_chars}.");
  }
  if (raw.length === 0) {
    return undefined;
  }
  if (raw.length > MAX_TOOL_RANGES) {
    throw new Error(`ranges admite un máximo de ${MAX_TOOL_RANGES} rangos por llamada.`);
  }

  const collected: WebFetchRangeSpec[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`rango inválido en la posición ${index + 1}: cada rango debe ser un objeto {offset_chars, limit_chars}.`);
    }
    const record = entry as Record<string, unknown>;
    const hasOffsetKey: boolean =
      record["offset_chars"] !== undefined
      || record["offsetChars"] !== undefined
      || record["offset"] !== undefined;
    const hasLimitKey: boolean =
      record["limit_chars"] !== undefined
      || record["limitChars"] !== undefined
      || record["limit"] !== undefined;
    // A broken item ({} or corrupt ints) must NOT silently collapse into an
    // offset-0 window — several broken items used to duplicate that ghost
    // window without any notice (live-audit V finding).
    if (!hasOffsetKey && !hasLimitKey) {
      throw new Error(
        `rango inválido en la posición ${index + 1}: falta offset_chars/offsetChars (u offset). Envía {offsetChars: <entero>, limitChars: <entero opcional>}.`,
      );
    }
    const offsetChars: number =
      strictOptionalInt(record["offset_chars"], `ranges[${index}].offset_chars`)
      ?? strictOptionalInt(record["offsetChars"], `ranges[${index}].offsetChars`)
      ?? strictOptionalInt(record["offset"], `ranges[${index}].offset`)
      ?? 0;
    const limitRaw: number | undefined =
      strictOptionalInt(record["limit_chars"], `ranges[${index}].limit_chars`)
      ?? strictOptionalInt(record["limitChars"], `ranges[${index}].limitChars`)
      ?? strictOptionalInt(record["limit"], `ranges[${index}].limit`);
    if (offsetChars < 0) {
      throw new Error(`ranges[${index}].offset_chars debe ser no negativo.`);
    }
    if (limitRaw !== undefined && limitRaw < 0) {
      throw new Error(`ranges[${index}].limit_chars debe ser positivo.`);
    }
    collected.push({
      offsetChars,
      limitChars: limitRaw === undefined || limitRaw === 0 ? undefined : Math.max(1, limitRaw)
    });
  }
  return collected;
}
