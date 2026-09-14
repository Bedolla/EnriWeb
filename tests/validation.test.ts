import { describe, expect, it } from "vitest";

import { assertHttpUrl, optionalInt, optionalStringArray } from "../src/shared/validation.js";

describe("shared validation", () => {
  it("floors finite numbers and still rejects partial numeric strings", () => {
    expect(optionalInt(7.5)).toBe(7);
    expect(optionalInt(7)).toBe(7);
    expect(optionalInt("7")).toBe(7);
    expect(optionalInt("7.5")).toBeUndefined();
    expect(optionalInt("abc")).toBeUndefined();
    expect(optionalInt(Number.NaN)).toBeUndefined();
  });

  it("accepts a single domain string as a one-element list", () => {
    expect(optionalStringArray("github.com", "allowed_domains")).toEqual(["github.com"]);
    expect(optionalStringArray(["a.test", "b.test"], "allowed_domains")).toEqual([
      "a.test",
      "b.test"
    ]);
    expect(optionalStringArray(undefined, "allowed_domains")).toBeUndefined();
    expect(optionalStringArray("   ", "allowed_domains")).toBeUndefined();
  });

  it("rejects invalid containers in Spanish like the proxy does", () => {
    expect(() => optionalStringArray(null, "allowed_domains")).toThrow(
      /allowed_domains debe ser un arreglo de strings\./
    );
    expect(() => optionalStringArray(42, "blocked_domains")).toThrow(
      /blocked_domains debe ser un arreglo de strings\./
    );
    expect(() =>
      optionalStringArray({ domain: "a.test" }, "allowed_domains")
    ).toThrow(/allowed_domains debe ser un arreglo de strings\./);
    expect(() => optionalStringArray(["a.test", 7], "allowed_domains")).toThrow(
      /Los filtros de dominios deben ser cadenas no vacías\./
    );
  });

  it("keeps protocol errors specific instead of generic", () => {
    expect(() => assertHttpUrl("ftp://example.com/x", "url")).toThrow(/HTTP o HTTPS/);
    expect(() => assertHttpUrl("not a url", "url")).toThrow(/válida/);
    expect(() => assertHttpUrl("", "url")).toThrow(/no vacía/);
  });
});
