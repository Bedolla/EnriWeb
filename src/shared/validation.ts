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
    throw new Error(`${name} must be an object.`);
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
    throw new Error(`${name} must be a string.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} must be a non-empty string.`);
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
  const url = assertNonEmptyString(value, name);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${name} must be an HTTP or HTTPS URL.`);
    }
    return parsed.toString();
  } catch {
    throw new Error(`${name} must be a valid URL.`);
  }
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
 * @param value - Value to check
 * @returns Integer or undefined
 */
export function optionalInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

/**
 * Returns a list of trimmed strings or undefined.
 *
 * @param value - Value to check
 * @returns String array or undefined
 */
export function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const collected: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed) {
      collected.push(trimmed);
    }
  }
  return collected.length > 0 ? collected : undefined;
}
