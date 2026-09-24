import { describe, expect, it } from "vitest";

import { WebSearchRegistryHttpReader } from "../src/tools/WebSearchRegistryHttpReader.js";

/**
 * Builds one stub fetch implementation that records Authorization headers.
 *
 * @param seen - Array collecting the Authorization header per request.
 * @returns Fetch implementation returning an empty JSON response.
 */
function captureAuthFetch(seen: Array<string | undefined>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request: Request = new Request(input, init);
    seen.push(request.headers.get("authorization") ?? undefined);
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("WebSearchRegistryHttpReader GitHub token gating", (): void => {
  it("sends the Authorization header to api.github.com", async (): Promise<void> => {
    const seen: Array<string | undefined> = [];
    const reader: WebSearchRegistryHttpReader = new WebSearchRegistryHttpReader({
      fetchImpl: captureAuthFetch(seen),
      timeoutMs: 2_000
    });

    await reader.fetchJson("https://api.github.com/repos/owner/repo", {
      accept: "application/vnd.github+json",
      githubToken: "gh-secret-token"
    });

    expect(seen[0]).toBe("Bearer gh-secret-token");
  });

  it("never sends the Authorization header to non-GitHub registry hosts", async (): Promise<void> => {
    const seen: Array<string | undefined> = [];
    const reader: WebSearchRegistryHttpReader = new WebSearchRegistryHttpReader({
      fetchImpl: captureAuthFetch(seen),
      timeoutMs: 2_000
    });

    await reader.fetchJson("https://registry.npmjs.org/-/package/vitest", {
      accept: "application/json",
      githubToken: "gh-secret-token"
    });
    await reader.fetchJson("https://pypi.org/pypi/requests/json", {
      accept: "application/json",
      githubToken: "gh-secret-token"
    });

    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toBeUndefined();
  });

  it("never sends the Authorization header over plain http even to github hosts", async (): Promise<void> => {
    const seen: Array<string | undefined> = [];
    const reader: WebSearchRegistryHttpReader = new WebSearchRegistryHttpReader({
      fetchImpl: captureAuthFetch(seen),
      timeoutMs: 2_000
    });

    await reader.fetchJson("http://api.github.com/repos/owner/repo", {
      accept: "application/vnd.github+json",
      githubToken: "gh-secret-token"
    });

    expect(seen[0]).toBeUndefined();
  });

  it("sends no Authorization header when no token is configured", async (): Promise<void> => {
    const seen: Array<string | undefined> = [];
    const reader: WebSearchRegistryHttpReader = new WebSearchRegistryHttpReader({
      fetchImpl: captureAuthFetch(seen),
      timeoutMs: 2_000
    });

    await reader.fetchJson("https://api.github.com/repos/owner/repo", {
      accept: "application/vnd.github+json"
    });

    expect(seen[0]).toBeUndefined();
  });
});
