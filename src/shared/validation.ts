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
