/**
 * Operator engine-selector parsing for `web_search`.
 *
 * @remarks
 * Extracted from the entrypoint so the validation is unit-testable without
 * importing (and starting) the MCP server.
 *
 * @module shared/operatorSearchEngines
 */

/**
 * Environment variable carrying the default SearXNG engine selector.
 */
export const SEARCH_ENGINES_ENV = "ENRIWEB_SEARCH_ENGINES";

/**
 * Maximum engine-selector characters accepted from the environment.
 *
 * @remarks
 * SearXNG engine names are short (`google`, `google,bing`); the ceiling only
 * rejects garbage/abuse, it is not a functional limit.
 */
export const MAX_SEARCH_ENGINES_CHARS = 200;

/**
 * Parses the operator engine selector for `web_search`.
 *
 * @remarks
 * The selector is operator configuration, never model input: blank means
 * "use the EnriProxy server default", and an invalid value warns on stderr
 * and degrades to unset instead of failing every search.
 *
 * @param raw - Raw environment value, if set.
 * @returns Trimmed engine selector, or undefined when unset/blank/invalid.
 */
export function parseSearchEnginesEnv(raw: string | undefined): string | undefined {
  const trimmed: string = (raw ?? "").trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_SEARCH_ENGINES_CHARS || !/^[A-Za-z0-9_\-][A-Za-z0-9_\-,\s]{0,199}$/.test(trimmed)) {
    console.error(
      `[EnriWeb] WARN: ignoring invalid ${SEARCH_ENGINES_ENV} (use SearXNG engine names separated by commas, e.g. "google").`
    );
    return undefined;
  }
  return trimmed;
}
