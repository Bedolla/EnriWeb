/**
 * Grouped-ranges execution for the web_fetch MCP tool.
 *
 * @remarks
 * Cursor slices are independent reads of one immutable capture: the batch
 * runs concurrently (bounded by MAX_TOOL_RANGES) with order following the
 * requested ranges — same semantics as EnriCode's grouped cursor ranges,
 * including the Spanish continuation hints and the early cursor release
 * when every window is exhausted. Extracted from {@link WebFetchTool}.
 *
 * @module tools/WebFetchRangesExecutor
 */

import { type EnriProxyClient, EnriProxyHttpError, MAX_WIRE_MAX_CHARS } from "../client/EnriProxyClient.js";
import { sliceUtf8Safe } from "../shared/Utf8SafeTextSlicer.js";
import {
  type WebFetchRangeSlice,
  type WebFetchRangeSpec,
  type WebFetchToolResult,
  type WebFetchToolRangesResult
} from "./WebFetchTool.js";

/**
 * Executes grouped ranges for the web_fetch tool.
 */
export class WebFetchRangesExecutor {
  /**
   * Reads the undecorated page one local range batch addresses.
   *
   * @param result - Single-read result holding the captured content.
   * @returns Raw page text (bounds-resolved when the proxy reported
   *   them, verbatim `content` otherwise).
   */
  public static readUndecoratedPage(result: WebFetchToolResult): string {
    const content: string = result.content;
    const pageOffset: unknown = result.page_offset_chars;
    const pageChars: unknown = result.page_chars;
    if (
      typeof pageOffset === "number" &&
      Number.isFinite(pageOffset) &&
      pageOffset >= 0 &&
      typeof pageChars === "number" &&
      Number.isFinite(pageChars) &&
      pageChars >= 0 &&
      pageOffset <= content.length
    ) {
      return sliceUtf8Safe(content, pageOffset, pageOffset + pageChars);
    }
    return content;
  }
  /**
   * Resolves the first-read capture budget for grouped ranges.
   *
   * @param ranges - Requested ranges
   * @param maxChars - Call budget
   * @returns Capture budget reaching the furthest requested range end
   */
  public resolveRangesCaptureMaxChars(
    ranges: readonly WebFetchRangeSpec[],
    maxChars: number
  ): number {
    const furthestEnd: number = Math.max(
      ...ranges.map((range: WebFetchRangeSpec): number => range.offsetChars + (range.limitChars ?? 0))
    );
    return Math.min(MAX_WIRE_MAX_CHARS, Math.max(maxChars, furthestEnd));
  }

  /**
   * Executes grouped ranges as concurrent cursor reads of one capture.
   *
   * @remarks
   * Cursor slices are independent reads of one immutable capture, so the
   * batch runs concurrently (bounded by {@link MAX_TOOL_RANGES}) with order
   * following the requested ranges — same semantics as EnriCode's grouped
   * cursor ranges. One failed slice does not kill the batch: every range
   * yields a result row and failures surface as Spanish `error` rows while
   * the surviving slices return normally. A definitive proxy rejection on
   * one slice (for example an expired cursor) cancels the sibling reads
   * through a shared signal, since every slice reads the same cursor.
   *
   * @param client - EnriProxy client
   * @param cursor - Cursor addressing the capture
   * @param ranges - Requested ranges
   * @param maxChars - Call budget used as default slice length
   * @param resolvedUrl - URL reported for the grouped result
   * @param signal - Optional caller abort signal
   * @returns Grouped ranges result
   * @throws Error when the caller cancelled the request mid-flight
   */
  public async executeGroupedCursorRanges(
    client: EnriProxyClient,
    cursor: string,
    ranges: readonly WebFetchRangeSpec[],
    maxChars: number,
    resolvedUrl: string,
    signal?: AbortSignal
  ): Promise<WebFetchToolRangesResult> {
    // Shared signal: caller aborts propagate to every slice, and a proxy
    // rejection on one slice cancels the siblings still in flight.
    const sharedController: AbortController = new AbortController();
    const forwardCallerAbort = (): void => {
      sharedController.abort();
    };
    if (signal !== undefined) {
      if (signal.aborted) {
        sharedController.abort();
      } else {
        signal.addEventListener("abort", forwardCallerAbort, { once: true });
      }
    }

    const settled: ReadonlyArray<PromiseSettledResult<WebFetchRangeSlice>> =
      await Promise.allSettled(
        ranges.map(
          async (range: WebFetchRangeSpec, index: number): Promise<WebFetchRangeSlice> => {
            const limitChars: number = range.limitChars ?? maxChars;
            try {
              const response = await client.webFetch(
                { cursor, offsetChars: range.offsetChars, limitChars, maxChars },
                sharedController.signal,
                {
                  // Per-slice byte ceiling: ten concurrent windows must not
                  // each reserve the full max_chars-derived cap (up to ~25MB);
                  // the expected slice payload bounds the buffer instead, so
                  // the grouped fan-out stays within a bounded transient
                  // memory budget instead of ~10x the call budget.
                  maxResponseBytes:
                    6 * Math.min(limitChars, MAX_WIRE_MAX_CHARS) + 1024 * 1024
                }
              );
              return {
                index: index + 1,
                offset_chars: range.offsetChars,
                limit_chars: limitChars,
                content: response.content,
                status: response.status,
                content_type: response.content_type,
                truncated: response.truncated,
                has_more: response.has_more,
                total_chars: response.total_chars,
                cursor: response.cursor
              };
            } catch (error) {
              // A definitive proxy answer (HTTP error) rejects the cursor
              // itself: every sibling slice would fail identically, so the
              // shared signal cancels them instead of burning the budget.
              if (error instanceof EnriProxyHttpError && !sharedController.signal.aborted) {
                sharedController.abort();
              }
              throw error;
            }
          }
        )
      );

    if (signal !== undefined) {
      signal.removeEventListener("abort", forwardCallerAbort);
    }

    // Caller cancellation keeps traveling as a thrown abort (SDK
    // cancellation semantics) instead of a grouped result of error rows.
    if (signal?.aborted) {
      throw new Error("La petición fue cancelada por el cliente.");
    }

    const abortedBySiblingFailure: boolean =
      sharedController.signal.aborted && signal?.aborted !== true;

    const slices: WebFetchRangeSlice[] = settled.map(
      (outcome: PromiseSettledResult<WebFetchRangeSlice>, index: number): WebFetchRangeSlice => {
        if (outcome.status === "fulfilled") {
          return outcome.value;
        }
        const range: WebFetchRangeSpec = ranges[index];
        const limitChars: number = range.limitChars ?? maxChars;
        // A definitive proxy answer keeps its own message (plus the Spanish
        // body diagnostic it carries) even when it triggered the shared
        // abort; sibling reads cancelled by that rejection get the
        // cancellation wording, and raw transport failures are wrapped in
        // Spanish so no English stack jargon reaches the model.
        const reason: string = WebFetchRangesExecutor.describeRangeFailure(
          outcome.reason,
          abortedBySiblingFailure
        );
        return {
          index: index + 1,
          offset_chars: range.offsetChars,
          limit_chars: limitChars,
          content: "",
          status: 0,
          content_type: "",
          truncated: false,
          error: `Rango ${String(index + 1)} falló: ${reason}`
        };
      }
    );

    // Early reclamation parity with EnriCode: only windows that actually
    // read content through the capture end count as exhaustion. Out-of-range
    // empty windows (has_more: false with no content) never release, so a
    // typo'd offset cannot destroy a capture whose bulk was never read.
    let captureReleased: boolean = false;
    const everyWindowReadThroughEnd: boolean =
      slices.length > 0 &&
      slices.every((slice: WebFetchRangeSlice): boolean =>
        slice.error === undefined &&
        slice.has_more === false &&
        slice.content.length > 0 &&
        (slice.total_chars === undefined || slice.offset_chars + slice.content.length >= slice.total_chars)
      );
    if (everyWindowReadThroughEnd) {
      if (signal?.aborted !== true) {
        captureReleased = true;
        void client
          .webFetch({ cursor, action: "delete" }, signal)
          .then((): void => undefined)
          .catch((): void => undefined);
      }
    }

    return {
      range_applied: true,
      range_count: slices.length,
      ranges: slices,
      truncated: slices.some((slice: WebFetchRangeSlice): boolean => slice.truncated),
      range_hint: captureReleased
        ? "Todas las ventanas agotaron la captura y el cursor quedó liberado del servidor; para releer el documento use la url original."
        : `Vuelva a llamar web_fetch con el mismo cursor (cursor="${cursor}") y ranges para pedir otros tramos no contiguos del documento sin volver a descargarlo.`,
      url: resolvedUrl,
      cursor
    };
  }

  /**
   * Describes one failed range read with an honest Spanish diagnostic.
   *
   * @param reason - Raw rejection reason of the failed slice.
   * @param abortedBySiblingFailure - Whether the shared batch abort fired.
   * @returns Spanish failure description for the model-facing error row.
   */
  private static describeRangeFailure(reason: unknown, abortedBySiblingFailure: boolean): string {
    if (reason instanceof EnriProxyHttpError) {
      const bodyDetail: string = sliceUtf8Safe(reason.body.trim(), 0, 300);
      return bodyDetail.length > 0 ? `${reason.message} ${bodyDetail}` : reason.message;
    }
    if (abortedBySiblingFailure) {
      return "lectura cancelada porque el servidor rechazó el cursor en otro rango del mismo lote";
    }
    if (reason instanceof Error) {
      return `fallo de red leyendo el rango (${sliceUtf8Safe(reason.message, 0, 120)})`;
    }
    return String(reason);
  }

  /**
   * Applies grouped ranges locally over already-fetched content.
   *
   * @remarks
   * A range whose offset lies beyond the UNDECORATED page is out of range,
   * not truncated: the slice comes back empty with an honest Spanish note
   * and `truncated: false`, so the model does not infer more pages behind
   * an empty window. A range that starts inside the page but hits its end
   * is the real truncation case. Windows address the raw page (via the
   * `page_offset_chars`/`page_chars` bounds the proxy reports), so the
   * status header and truncation footer never land inside a requested
   * window; responses without bounds slice `content` verbatim.
   *
   * @param result - Single-read result holding the captured content
   * @param ranges - Requested ranges
   * @param maxChars - Call budget used as default slice length
   * @returns Grouped ranges result
   */
  public applyLocalRangesToResult(
    result: WebFetchToolResult,
    ranges: readonly WebFetchRangeSpec[],
    maxChars: number
  ): WebFetchToolRangesResult {
    const page: string = WebFetchRangesExecutor.readUndecoratedPage(result);
    const slices: WebFetchRangeSlice[] = ranges.map(
      (range: WebFetchRangeSpec, index: number): WebFetchRangeSlice => {
        const limitChars: number = range.limitChars ?? maxChars;
        if (range.offsetChars >= page.length) {
          return {
            index: index + 1,
            offset_chars: range.offsetChars,
            limit_chars: limitChars,
            content: "",
            status: result.status,
            content_type: result.content_type,
            truncated: false,
            note: `El offset queda fuera de la página devuelta (${String(page.length)} caracteres sin decoraciones); este rango está vacío.`
          };
        }
        const slice: string = sliceUtf8Safe(page, range.offsetChars, range.offsetChars + limitChars);
        return {
          index: index + 1,
          offset_chars: range.offsetChars,
          limit_chars: limitChars,
          content: slice,
          status: result.status,
          content_type: result.content_type,
          truncated: range.offsetChars + limitChars > page.length
        };
      }
    );

    return {
      range_applied: true,
      range_count: slices.length,
      ranges: slices,
      truncated: result.truncated,
      range_hint:
        "Los rangos se aplicaron localmente sobre la captura devuelta; para leer más allá de la captura vuelva a llamar web_fetch con un max_chars mayor.",
      url: result.url,
      // Raw-capture continuation fields only travel when the delivered
      // content shares the raw base: a reduced excerpt pack reorders the
      // text, and an npm projection stitches a metadata header in front of
      // the README (its cursor addresses the README alone), so local offsets
      // would mispage the raw capture in both cases (EnriCode excludes the
      // same fields in its URL projections).
      ...(result.reduced === true || result.applied_max_chars !== undefined
        ? {}
        : result.cursor !== undefined
          ? { cursor: result.cursor }
          : {}),
      ...(result.reduced === true || result.applied_max_chars !== undefined
        ? {}
        : result.total_chars !== undefined
          ? { total_chars: result.total_chars }
          : {})
    };
  }
}
