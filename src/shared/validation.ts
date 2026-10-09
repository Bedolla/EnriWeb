/**
 * INPUT VALIDATION UTILITIES
 *
 * @module shared/validation
 */

/**
 * Asserts that value is a non-null object.
 *
 * @param value - Value to check
 * @param name - Parameter name for error messages
 * @returns Value as Record
 * @throws Error if not an object
 */
export function assertObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} debe ser un objeto.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Reads one optional integer that must be either a clean integer or absent.
 *
 * @remarks
 * The legacy `optionalInt` silently floors floats (2.9 -> 2) and silently
 * ignores corrupt strings ("abc" -> undefined), which reads downstream as
 * "parameter honored". This strict variant treats present-but-corrupt
 * values as contract violations with actionable coaching.
 *
 * @param value - Raw argument value
 * @param fieldName - Model-facing field name for the coaching error
 * @returns Clean integer, or undefined when absent (undefined/null/blank)
 * @throws Error when the value is present but not a clean integer
 */
export function strictOptionalInt(value: unknown, fieldName: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  if (typeof value === "number" && Number.isInteger(value) && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    const parsed: number = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const rendered: string = typeof value === "string" ? `"${value.trim()}"` : String(value);
  throw new Error(`${fieldName} inválido: ${rendered}. Envía un entero (ej. 2000) u omítelo.`);
}

/**
 * Asserts that value is a non-empty string.
 *
 * @param value - Value to check
 * @param name - Parameter name for error messages
 * @returns Trimmed string
 * @throws Error if not a non-empty string
 */
export function assertNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} debe ser una cadena.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} debe ser una cadena no vacía.`);
  }
  return trimmed;
}

/**
 * Asserts that value is a valid HTTP/HTTPS URL.
 *
 * @param value - Value to check
 * @param name - Parameter name for error messages
 * @returns URL string
 * @throws Error if not a valid HTTP/HTTPS URL
 */
export function assertHttpUrl(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} debe ser una cadena no vacía.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error(`${name} debe ser una URL válida.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} debe ser una URL HTTP o HTTPS.`);
  }
  return parsed.toString();
}

/**
 * Returns trimmed string or undefined.
 *
 * @param value - Value to check
 * @returns Trimmed string or undefined
 */
export function optionalString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }
  return undefined;
}

/**
 * Returns integer or undefined.
 *
 * @remarks
 * Finite numbers floor (parity with EnriProxy/EnriCode); numeric strings
 * must match fully (`"7"` ok, `"7.5"` dropped).
 *
 * @param value - Value to check
 * @returns Integer or undefined
 */
export function optionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const trimmed: string = value.trim();
    if (!/^-?\d+$/u.test(trimmed)) {
      return undefined;
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Returns a list of trimmed strings or undefined.
 *
 * @remarks
 * A single string is normalized to a one-element list (parity with
 * EnriProxy, which accepts `string | string[]` for domain filters). An
 * invalid container (null, number, object) fails in Spanish, matching the
 * proxy's 400 policy instead of being silently discarded.
 *
 * @param value - Value to check
 * @param name - Parameter name for error messages
 * @returns String array or undefined
 * @throws Error when the container or an entry is not a string
 */
export function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" && !Array.isArray(value)) {
    throw new Error(`${name} debe ser un arreglo de strings.`);
  }
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const collected: string[] = [];
  for (const entry of items) {
    if (typeof entry !== "string") {
      throw new Error("Los filtros de dominios deben ser cadenas no vacías.");
    }
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    collected.push(trimmed);
  }
  return collected.length > 0 ? collected : undefined;
}
