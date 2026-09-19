/**
 * Argument parsing for the web_fetch MCP tool.
 *
 * @remarks
 * Lenient for malformed optional values (they degrade to documented
 * defaults, matching the EnriCode client parser: unusable or out-of-domain
 * budgets fall back to the documented default instead of failing the call,
 * per the shared AR-4 client policy) but strict for structural mistakes
 * (broken ranges, unknown action without cursor), which fail fast in
 * Spanish. Snake_case field names
 * are canonical; camelCase aliases (maxChars, offsetChars, limitChars,
 * includeLinks, includeMetadata) are accepted as fallbacks for parity with
 * the EnriCode tool surface. Extracted from {@link WebFetchTool} as a pure
 * function module.
 *
 * @module tools/WebFetchParamsParser
 */

import { assertHttpUrl, assertObject, optionalInt, optionalString } from "../shared/validation.js";
import { sliceUtf8Safe } from "../shared/Utf8SafeTextSlicer.js";
import { MAX_ANCHOR_CHARS, MAX_TOOL_RANGES, type WebFetchToolParams, type WebFetchRangeSpec } from "./WebFetchTool.js";

/**
 * Validates raw MCP tool arguments.
 *
 * @param raw - Raw tool arguments
 * @returns Validated parameters
 */
export function parseWebFetchParams(raw: unknown): WebFetchToolParams {
  const obj = assertObject(raw, "arguments");

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
  // parity with the EnriCode tool surface.
  let maxChars = optionalInt(obj["max_chars"]) ?? optionalInt(obj["maxChars"]);
  // Invalid format/content values degrade to the documented defaults
  // ("text"/"main") instead of failing the call, matching EnriCode and
  // EnriProxy projection fallbacks.
  const format: "text" | "markdown" | "html" | undefined =
    obj["format"] === "markdown"
      ? "markdown"
      : obj["format"] === "text"
        ? "text"
        : obj["format"] === "html"
          ? "html"
          : undefined;
  const content: "main" | "full" | undefined =
    obj["content"] === "main" ? "main" : obj["content"] === "full" ? "full" : undefined;
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
    optionalInt(obj["offset_chars"]) ?? optionalInt(obj["offsetChars"]) ?? optionalInt(obj["offset"]);
  const limitCharsRaw =
    optionalInt(obj["limit_chars"]) ?? optionalInt(obj["limitChars"]) ?? optionalInt(obj["limit"]);
  const action: "delete" | undefined = obj["action"] === "delete" ? "delete" : undefined;
  const ranges = parseRanges(obj["ranges"]);
  // Strict enum parity with the proxy body parser: unknown values degrade
  // to "not requested" instead of failing the call.
  const screenshot: "auto" | "force" | "none" | "analyze" | undefined =
    obj["screenshot"] === "auto" ||
    obj["screenshot"] === "force" ||
    obj["screenshot"] === "none" ||
    obj["screenshot"] === "analyze"
      ? obj["screenshot"]
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
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("cada rango en ranges debe ser un objeto {offset_chars, limit_chars}.");
    }
    const record = entry as Record<string, unknown>;
    const offsetChars: number =
      optionalInt(record["offset_chars"]) ?? optionalInt(record["offsetChars"]) ?? optionalInt(record["offset"]) ?? 0;
    const limitRaw: number | undefined =
      optionalInt(record["limit_chars"]) ?? optionalInt(record["limitChars"]) ?? optionalInt(record["limit"]);
    if (offsetChars < 0) {
      throw new Error("offset_chars de cada rango debe ser no negativo.");
    }
    if (limitRaw !== undefined && limitRaw < 0) {
      throw new Error("limit_chars de cada rango debe ser positivo.");
    }
    collected.push({
      offsetChars,
      limitChars: limitRaw === undefined || limitRaw === 0 ? undefined : Math.max(1, limitRaw)
    });
  }
  return collected;
}
