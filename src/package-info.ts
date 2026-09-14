import { createRequire } from "node:module";

/**
 * Shape of the package manifest fields consumed by {@link PackageInfoService}.
 */
interface PackageJsonShape {
  /**
   * Package version string, when the manifest is readable.
   */
  readonly version?: unknown;
}

/**
 * Resolves the installed package version for MCP server metadata.
 *
 * @remarks
 * The manifest is resolved relative to this module (not the process cwd), so
 * global installs and dev checkouts both resolve their own package.json. The
 * first successful read is cached for the process lifetime; an unreadable
 * manifest degrades to "0.0.0" instead of failing server startup.
 */
export class PackageInfoService {
  /**
   * Manifest require function bound to this module's location.
   */
  private readonly require: NodeRequire;

  /**
   * Cached version string, or null before the first resolution.
   */
  private cachedVersion: string | null = null;

  /**
   * Creates a new {@link PackageInfoService}.
   */
  public constructor() {
    this.require = createRequire(import.meta.url);
  }

  /**
   * Gets the installed package version.
   *
   * @returns Manifest version, or "0.0.0" when the manifest is unreadable.
   */
  public getVersion(): string {
    if (this.cachedVersion !== null) {
      return this.cachedVersion;
    }

    const fallback = "0.0.0";
    try {
      const pkg = this.require("../package.json") as PackageJsonShape;
      const version = pkg.version;
      if (typeof version === "string" && version.trim().length > 0) {
        this.cachedVersion = version;
        return version;
      }
    } catch {
      // Manifest unreadable (embedded/bundled contexts): fall back below.
    }

    this.cachedVersion = fallback;
    return fallback;
  }
}

/**
 * Process-wide package info service instance.
 */
export const packageInfoService: PackageInfoService = new PackageInfoService();
