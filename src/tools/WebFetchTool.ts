/**
 * WEB FETCH TOOL
 *
 * Implements the `web_fetch` MCP tool by delegating to EnriProxy.
 *
 * Size note (~610 lines, alert zone by design): this class owns the
 * url/cursor/ranges/npm dispatch plus their result contracts in one
 * readable place; the parser, ranges executor, npm projection and text
 * formatter already live in dedicated modules. Splitting is tracked debt;
 * any future edit must extract the touched unit instead of growing this
 * file.
 *
 * @module tools/WebFetchTool
 */
import { type EnriProxyClient, MAX_WIRE_MAX_CHARS, isExpiredCursorError, isExpiredCursorMessageText } from "../client/EnriProxyClient.js";
import { WebFetchNpmProjection } from "./WebFetchNpmProjection.js";
import { parseWebFetchParams } from "./WebFetchParamsParser.js";
import { WebFetchRangesExecutor } from "./WebFetchRangesExecutor.js";
import { WebFetchToolTextFormatter } from "./WebFetchToolTextFormatter.js";
import { assertHttpUrl, assertNonEmptyString } from "../shared/validation.js";

/**
 * Tool parameters for `web_fetch`.
 */
export interface WebFetchToolParams {
  /**
   * URL to fetch.
   */
  readonly url?: string;

  /**
   * Cursor identifier returned by a previous call.
   */
  readonly cursor?: string;

  /**
   * Optional prompt for extraction.
   */
  readonly prompt?: string;

  /**
   * Maximum content length in characters.
   */
  readonly maxChars?: number;

  /**
   * Content flavor for HTML sources: light text (default), full markdown, or
   * sanitized markup for DOM inspection.
   */
  readonly format?: "text" | "markdown" | "html";

  /**
   * Content scope for HTML sources: main content region only (default), or
   * the full page.
   */
  readonly content?: "main" | "full";

  /**
   * Whether to append the page link inventory.
   */
  readonly includeLinks?: boolean;

  /**
   * Whether to append the extended metadata block.
   */
  readonly includeMetadata?: boolean;

  /**
   * Optional anchor selector restricting the projection to one section.
   */
  readonly anchor?: string;

  /**
   * Offset in characters for cursor pagination.
   */
  readonly offsetChars?: number;

  /**
   * Limit in characters for cursor pagination.
   */
  readonly limitChars?: number;

  /**
   * Special cursor action: "delete" releases the server-side capture.
   */
  readonly action?: "delete";

  /**
   * Grouped character ranges read in one call (max 10).
   */
  readonly ranges?: readonly WebFetchRangeSpec[];

  /**
   * Screenshot mode for the fetched page. Pick by what YOUR model can do:
   *
   * - No field (or "auto"): server captures screenshots ONLY when the page
   *   has very little text (games, dashboards, maps). Images arrive as MCP
   *   image blocks — use this only if your model can SEE images.
   * - "analyze": USE THIS IF YOUR MODEL CANNOT SEE IMAGES. The server
   *   captures the page and returns a TEXT DESCRIPTION of what it looks
   *   like ("Análisis visual: ...") in `screenshot_analyses`. No images are
   *   returned, so blind models never break.
   * - "force": always capture and return image blocks (needs vision).
   * - "none": never capture anything; pure text, cheapest.
   *
   * @remarks
   * The proxy treats an ABSENT field as "auto". Honored only on plain URL
   * single reads; cursor/ranges/delete modes ignore it.
   */
  readonly screenshot?: "auto" | "force" | "none" | "analyze";
}

/**
 * One grouped character range for `web_fetch`.
 */
export interface WebFetchRangeSpec {
  /**
   * Zero-based start offset in characters.
   */
  readonly offsetChars: number;

  /**
   * Range length in characters; omitted falls back to the call budget.
   */
  readonly limitChars?: number;
}

/**
 * Tool result for `web_fetch`.
 */
export interface WebFetchToolResult extends Record<string, unknown> {
  /**
   * Fetched content.
   */
  readonly content: string;

  /**
   * HTTP status code.
   */
  readonly status: number;

  /**
   * Content type of the response.
   */
  readonly content_type: string;

  /**
   * Whether content was truncated.
   */
  readonly truncated: boolean;

  /**
   * URL that was fetched.
   */
  readonly url: string;

  /**
   * Cursor identifier for pagination (when available).
   */
  readonly cursor?: string;

  /**
   * Offset in characters (cursor reads).
   */
  readonly offset_chars?: number;

  /**
   * Limit in characters (cursor reads).
   */
  readonly limit_chars?: number;

  /**
   * Total captured characters (cursor reads).
   */
  readonly total_chars?: number;

  /**
   * Whether more content exists beyond this slice.
   */
  readonly has_more?: boolean;

  /**
   * Exact offset where the next page starts, when the proxy reports it
   * (cursor reads).
   */
  readonly next_offset_chars?: number;

  /**
   * Budget applied to compose this result (npm stitching path). When the
   * winning README sub-fetch issued a continuation cursor, that cursor (and
   * the raw capture `total_chars`) propagates so pagination needs no
   * re-download; otherwise retry with a larger `max_chars` for more content.
   */
  readonly applied_max_chars?: number;

  /**
   * Whether content was reduced into an excerpt pack.
   */
  readonly reduced?: boolean;

  /**
   * Whether the upstream fetch was truncated.
   */
  readonly fetched_truncated?: boolean;

  /**
   * Zero-based offset inside `content` where the undecorated page starts
   * (passthrough of the proxy's bounds for local range windows).
   */
  readonly page_offset_chars?: number;

  /**
   * Length of the undecorated page inside `content` (passthrough of the
   * proxy's bounds for local range windows).
   */
  readonly page_chars?: number;

  /**
   * True when the dead cursor supplied with the call expired server-side and
   * the tool transparently re-fetched `url` with the same parameters: the
   * returned offsets address the fresh capture and `cursor` (when present)
   * is the new cursor. Never re-send the previous cursor.
   */
  readonly recovered_from_expired_cursor?: boolean;

  /**
   * Spanish note describing the transparent expired-cursor recovery.
   */
  readonly recovery_note?: string;

  /**
   * Captured page screenshots in scroll order, when a screenshot request
   * passed the proxy's capture policy.
   *
   * @remarks
   * Raw passthrough for the server layer: the MCP handler moves these to
   * image content blocks and omits them from `structuredContent` (the
   * text/JSON channels must never inline the base64 payloads).
   */
  readonly screenshots?: readonly WebFetchResultScreenshot[];

  /**
   * Whether the proxy captured screenshots ("captured"), analyzed them
   * server-side into text ("analyzed"), or skipped them ("skipped").
   */
  readonly screenshot_status?: "captured" | "analyzed" | "skipped";

  /**
   * Why screenshots were captured or skipped (e.g. "auto_thin_text",
   * "forced", "analyze_requested", "auto_rich_text", "lane_unsupported",
   * "capture_failed").
   */
  readonly screenshot_reason?: string;

  /**
   * Text descriptions of the page screenshots produced server-side by the
   * `screenshot: "analyze"` mode, one per scroll segment. Present only when
   * `screenshot_status` is "analyzed"; entries can be `null` when one
   * segment failed analysis.
   */
  readonly screenshot_analyses?: ReadonlyArray<string | null>;
}

/**
 * One captured page screenshot segment attached to a web_fetch result.
 */
export interface WebFetchResultScreenshot {
  /**
   * Image MIME type (always `image/jpeg`).
   */
  readonly mime_type: string;

  /**
   * Base64-encoded image bytes.
   */
  readonly base64: string;

  /**
   * Image width in pixels.
   */
  readonly width: number;

  /**
   * Image height in pixels.
   */
  readonly height: number;

  /**
   * Window scrollY (pixels) at capture time.
   */
  readonly scroll_y: number;
}

/**
 * Result for `action: "delete"` cursor release.
 */
export interface WebFetchToolDeleteResult extends Record<string, unknown> {
  /**
   * Whether the cursor existed and was deleted server-side.
   */
  readonly deleted: boolean;

  /**
   * Cursor the deletion addressed.
   */
  readonly cursor: string;
}

/**
 * One slice produced for a grouped-ranges read.
 */
export interface WebFetchRangeSlice {
  /**
   * One-based range index in request order.
   */
  readonly index: number;

  /**
   * Requested zero-based character offset.
   */
  readonly offset_chars: number;

  /**
   * Requested maximum character count.
   */
  readonly limit_chars: number;

  /**
   * Slice content.
   */
  readonly content: string;

  /**
   * HTTP status of the underlying read.
   */
  readonly status: number;

  /**
   * Content type of the underlying read.
   */
  readonly content_type: string;

  /**
   * Whether this slice was truncated.
   */
  readonly truncated: boolean;

  /**
   * Spanish error row when this range's read failed; the slice carries no
   * content in that case.
   */
  readonly error?: string;

  /**
   * Spanish model-facing note explaining an empty slice (offset beyond the
   * captured content).
   */
  readonly note?: string;

  /**
   * Whether more content exists beyond this slice (cursor reads).
   */
  readonly has_more?: boolean;

  /**
   * Total captured characters for this cursor.
   */
  readonly total_chars?: number;

  /**
   * Continuation cursor (cursor reads).
   */
  readonly cursor?: string;
}

/**
 * Grouped result for a `ranges` call (cursor fan-out or local slicing).
 */
export interface WebFetchToolRangesResult extends Record<string, unknown> {
  /**
   * Marker distinguishing grouped-range results.
   */
  readonly range_applied: true;

  /**
   * Number of returned ranges.
   */
  readonly range_count: number;

  /**
   * Range slices in request order.
   */
  readonly ranges: readonly WebFetchRangeSlice[];

  /**
   * Whether at least one slice was truncated.
   */
  readonly truncated: boolean;

  /**
   * Spanish continuation hint for the model.
   */
  readonly range_hint: string;

  /**
   * URL the ranges were read from.
   */
  readonly url: string;

  /**
   * Cursor backing the capture, when one exists.
   */
  readonly cursor?: string;

  /**
   * Total capture size in characters, when the base read reported it.
   */
  readonly total_chars?: number;

  /**
   * True when the dead cursor supplied with the call expired server-side and
   * the tool transparently re-fetched `url` with the same parameters (see
   * `recovered_from_expired_cursor` on {@link WebFetchToolResult}).
   */
  readonly recovered_from_expired_cursor?: boolean;

  /**
   * Spanish note describing the transparent expired-cursor recovery.
   */
  readonly recovery_note?: string;
}

/**
 * Result union for {@link WebFetchTool.execute}.
 */
export type WebFetchToolExecuteResult =
  | WebFetchToolResult
  | WebFetchToolDeleteResult
  | WebFetchToolRangesResult;

/**
 * Dependencies for {@link WebFetchTool}.
 */
export interface WebFetchToolDeps {
  /**
   * Creates an EnriProxy client with a base URL, API key, and timeout.
   *
   * @param serverUrl - EnriProxy URL
   * @param apiKey - EnriProxy API key
   * @param timeoutMs - Timeout in ms
   * @returns Client instance
   */
  readonly createClient: (serverUrl: string, apiKey: string, timeoutMs: number) => EnriProxyClient;

  /**
   * Default EnriProxy server URL.
   */
  readonly defaultServerUrl: string;

  /**
   * Default EnriProxy API key.
   */
  readonly defaultApiKey: string;

  /**
   * Default timeout in milliseconds.
   */
  readonly defaultTimeoutMs: number;

  /**
   * Default maximum content length in characters returned by the tool when
   * `max_chars` is not provided.
   */
  readonly defaultMaxChars: number;

  /**
   * Installation-level default screenshot mode used when the host omits the
   * `screenshot` parameter. Explicit host parameters always win.
   *
   * @remarks
   * Set via `ENRIWEB_SCREENSHOT_MODE` for clients whose provider rejects
   * image blocks in tool results (OpenAI-compatible Chat Completions APIs
   * accept images in user messages but not in tool messages — e.g. OpenCode
   * surfaces "this model does not support image input"). `analyze` turns
   * captures into server-side text descriptions for such installs.
   */
  readonly defaultScreenshotMode?: "auto" | "force" | "none" | "analyze";
}

/**
 * Maximum grouped ranges honored per call (parity with EnriCode).
 */
export const MAX_TOOL_RANGES = 10;

/**
 * Maximum anchor-selector characters honored per call (parity with
 * EnriCode's `WebFetchToolInputSchemaRecord.MAX_ANCHOR_CHARS` and
 * EnriProxy's `WEB_FETCH_MAX_ANCHOR_CHARS`).
 *
 * @remarks
 * The clamp is surrogate-safe through `sliceUtf8Safe`, so the unit is
 * UTF-16 code units with pair safety at the cut. Single source for the
 * parser clamp and the inputSchema `maxLength`/description so they can
 * never drift apart.
 */
export const MAX_ANCHOR_CHARS = 300;

/**
 * MCP tool that fetches URL content via EnriProxy.
 */
export class WebFetchTool {
  /**
   * npm package-page projection collaborator.
   */
  private readonly npmProjection: WebFetchNpmProjection = new WebFetchNpmProjection();

  /**
   * Grouped-ranges execution collaborator.
   */
  private readonly rangesExecutor: WebFetchRangesExecutor = new WebFetchRangesExecutor();

  /**
   * Tool dependencies.
   */
  private readonly deps: WebFetchToolDeps;

  /**
   * Creates a new {@link WebFetchTool}.
   *
   * @param deps - Tool dependencies
   */
  public constructor(deps: WebFetchToolDeps) {
    this.deps = deps;
  }

  /**
   * Gets the configured default max chars for web fetch results.
   *
   * @returns Default max chars
   */
  public getDefaultMaxChars(): number {
    return this.deps.defaultMaxChars;
  }

  /**
   * Validates raw MCP tool arguments.
   *
   * @param raw - Raw tool arguments
   * @returns Validated parameters
   */
  public parseParams(raw: unknown): WebFetchToolParams {
    return parseWebFetchParams(raw);
  }

  /**
   * Executes the web fetch tool.
   *
   * @param params - Validated parameters
   * @param signal - Optional caller abort signal
   * @returns Tool result (single read, delete outcome, or grouped ranges)
   */
  public async execute(
    params: WebFetchToolParams,
    signal?: AbortSignal
  ): Promise<WebFetchToolExecuteResult> {
    const serverUrl = assertHttpUrl(this.deps.defaultServerUrl, "ENRIPROXY_URL");
    const apiKey = assertNonEmptyString(this.deps.defaultApiKey, "ENRIPROXY_API_KEY");

    const client = this.deps.createClient(serverUrl, apiKey, this.deps.defaultTimeoutMs);
    // The documented default governs direct fetches too (the proxy would
    // otherwise apply its own tool-preview budget silently).
    const maxChars: number =
      typeof params.maxChars === "number"
        ? Math.min(params.maxChars, MAX_WIRE_MAX_CHARS)
        : Math.min(this.deps.defaultMaxChars, MAX_WIRE_MAX_CHARS);
    // Projection defaults are sent explicitly (matching the documented
    // schema defaults, EnriCode parity, and the service effective defaults
    // in WebFetchService.projectHtml): main scope with link inventory on.
    const format: "text" | "markdown" | "html" = params.format ?? "text";
    const content: "main" | "full" = params.content ?? "main";
    const includeLinks: boolean = params.includeLinks ?? true;
    const includeMetadata: boolean = params.includeMetadata ?? false;
    const cursor: string | undefined =
      typeof params.cursor === "string" && params.cursor.trim() ? params.cursor.trim() : undefined;
    const ranges: readonly WebFetchRangeSpec[] | undefined =
      params.ranges && params.ranges.length > 0 ? params.ranges : undefined;
    // URL-mode windows sliced locally over the returned content: the grouped
    // `ranges` list, or a single offset_chars/limit_chars window over the
    // first read (EnriCode first-read parity). Cursor reads send offset/limit
    // to the proxy directly, so no local window applies in cursor mode.
    const localSliceRanges: readonly WebFetchRangeSpec[] =
      ranges !== undefined
        ? ranges
        : cursor !== undefined ||
            (params.offsetChars === undefined && params.limitChars === undefined)
          ? []
          : [
              {
                offsetChars: params.offsetChars ?? 0,
                ...(params.limitChars !== undefined ? { limitChars: params.limitChars } : {})
              }
            ];
    // Local slicing needs the capture to reach the furthest window end, so
    // the first read asks for that budget.
    const effectiveMaxChars: number =
      localSliceRanges.length > 0
        ? this.rangesExecutor.resolveRangesCaptureMaxChars(localSliceRanges, maxChars)
        : maxChars;

    if (params.action === "delete") {
      if (!cursor) {
        throw new Error("action 'delete' requiere 'cursor'.");
      }
      const response = await client.webFetch({ cursor, action: "delete" }, signal);
      return { deleted: response.deleted, cursor: response.cursor || cursor };
    }

    if (cursor && ranges) {
      let grouped: WebFetchToolRangesResult;
      try {
        grouped = await this.rangesExecutor.executeGroupedCursorRanges(
          client,
          cursor,
          ranges,
          maxChars,
          params.url ?? "(cursor)",
          signal
        );
      } catch (error) {
        if (isExpiredCursorError(error) && WebFetchTool.usableRecoveryUrl(params.url)) {
          return await this.recoverFromExpiredCursor(params, cursor, signal);
        }
        throw error;
      }
      if (
        WebFetchTool.allSlicesExpired(grouped) &&
        WebFetchTool.usableRecoveryUrl(params.url)
      ) {
        return await this.recoverFromExpiredCursor(params, cursor, signal);
      }
      return grouped;
    }

    if (cursor) {
      let response;
      try {
        response = await client.webFetch(
          {
            cursor,
            offsetChars: params.offsetChars,
            limitChars: params.limitChars,
            maxChars
          },
          signal
        );
      } catch (error) {
        if (isExpiredCursorError(error) && WebFetchTool.usableRecoveryUrl(params.url)) {
          return await this.recoverFromExpiredCursor(params, cursor, signal);
        }
        throw error;
      }

      // Early reclamation parity with EnriCode: only a window that actually
      // delivered content through the capture end counts as exhaustion. An
      // out-of-range empty read (has_more: false with no content, e.g. a
      // typo'd offset) never releases, so the capture's unread bulk survives
      // for the corrected pagination.
      const readThroughEnd: boolean =
        response.has_more === false &&
        response.content.length > 0 &&
        (response.total_chars === undefined ||
          (response.offset_chars ?? 0) + response.content.length >= response.total_chars);
      if (readThroughEnd && signal?.aborted !== true) {
        void client
          .webFetch({ cursor, action: "delete" }, signal)
          .then((): void => undefined)
          .catch((): void => undefined);
      }

      const resolvedUrl = response.url ?? params.url ?? "(cursor)";
      // The exhausted capture was released above, so its cursor is dead
      // server-side: continuation fields are omitted from the result and the
      // formatter reports a complete read instead of pointing the model at a
      // cursor whose next read would 400 — matching the grouped-ranges
      // release hint in WebFetchRangesExecutor. Out-of-range empty reads
      // keep their cursor and continuation fields, so the model can retry
      // with a corrected offset instead of re-downloading by URL.
      const exhausted: boolean = readThroughEnd;
      return {
        content: response.content,
        status: response.status,
        content_type: response.content_type,
        truncated: response.truncated,
        url: resolvedUrl,
        ...(exhausted ? {} : { cursor: response.cursor }),
        offset_chars: response.offset_chars,
        limit_chars: response.limit_chars,
        total_chars: response.total_chars,
        has_more: response.has_more,
        ...(exhausted ? {} : { next_offset_chars: response.next_offset_chars }),
        reduced: response.reduced,
        fetched_truncated: response.fetched_truncated,
        page_offset_chars: response.page_offset_chars,
        page_chars: response.page_chars
      };
    }

    if (!params.url) {
      throw new Error("web_fetch requiere una URL cuando no se proporciona cursor.");
    }

    const url: string = params.url;
    const urlParams: WebFetchToolParams & { readonly url: string } = {
      ...params,
      url
    };

    const npmResult = await this.npmProjection.tryExecuteNpmPackageFetch(
      urlParams,
      client,
      effectiveMaxChars,
      {
        format,
        content,
        includeLinks,
        includeMetadata,
        ...(params.anchor !== undefined ? { anchor: params.anchor } : {}),
        ...(params.prompt !== undefined ? { prompt: params.prompt } : {})
      },
      signal
    );
    if (npmResult) {
      return localSliceRanges.length > 0
        ? this.rangesExecutor.applyLocalRangesToResult(npmResult, localSliceRanges, maxChars)
        : npmResult;
    }

    const response = await client.webFetch(
      {
        url,
        prompt: params.prompt,
        maxChars: effectiveMaxChars,
        format,
        content,
        includeLinks,
        includeMetadata,
        anchor: params.anchor,
        // Screenshots ride only plain full reads: grouped/single local
        // windows transform the result (ranges projector) and would drop
        // the captured segments silently. The installation default covers
        // hosts that never pass the parameter (blind-vision installs on
        // OpenAI-compatible backends); explicit host values win.
        ...((params.screenshot ?? this.deps.defaultScreenshotMode) !== undefined &&
        localSliceRanges.length === 0
          ? { screenshot: params.screenshot ?? this.deps.defaultScreenshotMode }
          : {})
      },
      signal
    );

    if (ranges && response.truncated && typeof response.cursor === "string" && response.cursor) {
      return await this.rangesExecutor.executeGroupedCursorRanges(
        client,
        response.cursor,
        ranges,
        maxChars,
        response.url ?? url,
        signal
      );
    }

    const single: WebFetchToolResult = {
      content: response.content,
      status: response.status,
      content_type: response.content_type,
      truncated: response.truncated,
      url: response.url ?? url,
      cursor: response.cursor,
      total_chars: response.total_chars,
      has_more: response.has_more,
      next_offset_chars: response.next_offset_chars,
      reduced: response.reduced,
      fetched_truncated: response.fetched_truncated,
      page_offset_chars: response.page_offset_chars,
      page_chars: response.page_chars,
      ...(response.screenshots !== undefined && response.screenshots.length > 0
        ? { screenshots: response.screenshots }
        : {}),
      ...(response.screenshot_status !== undefined ? { screenshot_status: response.screenshot_status } : {}),
      ...(response.screenshot_reason !== undefined ? { screenshot_reason: response.screenshot_reason } : {}),
      ...(response.screenshot_analyses !== undefined
        ? { screenshot_analyses: response.screenshot_analyses }
        : {})
    };
    return localSliceRanges.length > 0
      ? this.rangesExecutor.applyLocalRangesToResult(single, localSliceRanges, maxChars)
      : single;
  }

  /**
   * Reports whether a coexisting `url` can back transparent expired-cursor
   * recovery (the parser already drops non-http shapes on cursor calls; this
   * re-checks at the use site so recovery never fires on a display label).
   *
   * @param url - Candidate recovery URL.
   * @returns True for usable http(s) URLs.
   */
  private static usableRecoveryUrl(url: string | undefined): url is string {
    return typeof url === "string" && /^https?:\/\//iu.test(url);
  }

  /**
   * Reports whether every slice of a grouped result failed on the same dead
   * cursor (mid-batch expiry surfaces as error rows, not a throw).
   *
   * @param grouped - Grouped-ranges result to inspect.
   * @returns True when all slices carry the expired-cursor diagnostic.
   */
  private static allSlicesExpired(grouped: WebFetchToolRangesResult): boolean {
    return (
      grouped.range_count > 0 &&
      grouped.ranges.every(
        (slice): boolean => slice.error !== undefined && isExpiredCursorMessageText(slice.error)
      )
    );
  }

  /**
   * Transparently recovers an expired-cursor read by re-issuing the initial
   * URL read with the same parameters.
   *
   * @remarks
   * The fresh call drops `cursor`/`action`, so it always terminates: it runs
   * the regular URL path (npm projection, grouped or local ranges) and the
   * result is tagged with the recovery marker plus a Spanish note. Offsets in
   * the returned payload address the fresh capture, which reproduces the dead
   * one only when the source and projection parameters are unchanged.
   *
   * @param params - Original cursor-mode parameters (with recovery URL).
   * @param expiredCursor - Dead cursor that triggered the recovery.
   * @param signal - Optional caller abort signal.
   * @returns Fresh URL-mode result tagged as recovered.
   */
  private async recoverFromExpiredCursor(
    params: WebFetchToolParams,
    expiredCursor: string,
    signal?: AbortSignal
  ): Promise<WebFetchToolExecuteResult> {
    const freshParams: WebFetchToolParams = { ...params, cursor: undefined, action: undefined };
    const fresh: WebFetchToolExecuteResult = await this.execute(freshParams, signal);
    if ("deleted" in fresh) {
      return fresh;
    }
    const freshCursor: unknown = (fresh as WebFetchToolResult).cursor;
    const hasNewCursor: boolean = typeof freshCursor === "string" && freshCursor.length > 0;
    const recoveryNote: string =
      `El cursor anterior expiró en el servidor (TTL ~10 minutos) y el contenido se volvió a obtener de la url con los mismos parámetros; los offsets de esta respuesta aplican a la captura nueva, no a la anterior.` +
      (hasNewCursor ? ` Continúe con el cursor nuevo; no reintente el anterior (${expiredCursor}).` : ``);
    return { ...fresh, recovered_from_expired_cursor: true, recovery_note: recoveryNote };
  }

  /**
   * Formats results for MCP text output.
   *
   * @param result - Tool result (single read, delete outcome, or ranges)
   * @returns Formatted text
   */
  public formatOutput(result: WebFetchToolExecuteResult): string {
    return WebFetchToolTextFormatter.format(result);
  }
}
