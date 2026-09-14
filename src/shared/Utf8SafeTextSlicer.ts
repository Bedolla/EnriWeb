/**
 * Surrogate-safe UTF-16 text slicing.
 *
 * @remarks
 * Port of EnriCode's `Utf8SafeTextSlicer` (same semantics, single source per
 * project): character offsets address UTF-16 code units and a cut that would
 * land between the high and low surrogate of one pair backs off one unit, so
 * model-facing content never carries an orphan surrogate.
 *
 * Known cross-plane divergence (documented, accepted): when a window START
 * lands on a low surrogate this slicer backs the begin off to the pair's
 * high surrogate, so that window can measure `limit + 1` units while
 * keeping the pair intact and paginating without loss (the next window
 * never skips the pair). EnriProxy's cursor-store window advances past the
 * lone low surrogate instead (always `<= limit`). Both directions are
 * pair-safe and lossless within their own plane; the budgets differ by at
 * most one code unit at mid-pair boundaries.
 *
 * @module shared/Utf8SafeTextSlicer
 */

/**
 * Low-surrogate range start (inclusive).
 */
const LOW_SURROGATE_START = 0xdc00;

/**
 * Low-surrogate range end (inclusive).
 */
const LOW_SURROGATE_END = 0xdfff;

/**
 * Slices one string between UTF-16 code-unit offsets without splitting
 * surrogate pairs.
 *
 * @param text - Source text.
 * @param start - Inclusive start offset (clamped to the text length).
 * @param end - Exclusive end offset (values beyond the text length clamp).
 * @returns Substring that never starts or ends between a high and a low
 *   surrogate.
 */
export function sliceUtf8Safe(text: string, start: number, end: number): string {
  const value: string = String(text ?? "");
  const beginRaw: number = Number.isFinite(start) ? Math.floor(start) : 0;
  const endRaw: number = Number.isFinite(end) ? Math.floor(end) : value.length;
  let begin: number = Math.min(Math.max(beginRaw, 0), value.length);
  let stop: number = Math.min(Math.max(endRaw, begin), value.length);
  if (isLowSurrogateUnit(value, begin)) {
    begin -= 1;
  }
  if (begin < 0) {
    begin = 0;
  }
  if (stop > begin && stop < value.length && isLowSurrogateUnit(value, stop)) {
    stop -= 1;
  }
  return value.slice(begin, stop);
}

/**
 * Reports whether the code unit at one index is a low surrogate, meaning the
 * previous code unit holds the matching high surrogate of one pair.
 *
 * @param value - Source text.
 * @param index - Code-unit index.
 * @returns True when the index holds a low surrogate inside the text.
 */
function isLowSurrogateUnit(value: string, index: number): boolean {
  if (index <= 0 || index >= value.length) {
    return false;
  }
  const codeUnit: number = value.charCodeAt(index);
  return codeUnit >= LOW_SURROGATE_START && codeUnit <= LOW_SURROGATE_END;
}

/**
 * Truncates one visible text to a UTF-16 code-unit budget.
 *
 * @remarks
 * The cut never splits a surrogate pair and the returned value (including
 * the ellipsis) never exceeds `maxLength` code units — the same budget
 * contract EnriCode's transcript surfaces use.
 *
 * @param value - Source text.
 * @param maxLength - Maximum retained UTF-16 code units (including the
 *   ellipsis when appended).
 * @param ellipsis - Whether to append the single-unit ellipsis marker.
 * @returns Bounded text, or the original value when it already fits.
 */
export function truncateUtf8Safe(value: string, maxLength: number, ellipsis: boolean = true): string {
  const text: string = String(value ?? "");
  const budget: number = Number.isFinite(maxLength) ? Math.floor(maxLength) : text.length;
  if (budget <= 0) {
    return "";
  }
  if (text.length <= budget) {
    return text;
  }
  const cut: string = sliceUtf8Safe(text, 0, ellipsis ? Math.max(0, budget - 1) : budget).trimEnd();
  return ellipsis ? `${cut}…` : cut;
}
