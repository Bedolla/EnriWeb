# EnriWeb Status

Last Updated: 2026-08-26

## Current State
- EnriWeb is a client-side MCP server (npm: `@bedolla/enriweb`) exposing `web_search` and `web_fetch`; the package is prepared as version `0.1.2`.
- Tools delegate to EnriProxy endpoints (`/v1/tools/web_search`, `/v1/tools/web_fetch`) for multi-tier execution.
- `web_fetch` exposes the full HTML projection option set — `format` (`"text"` default | `"markdown"` | `"html"` sanitized markup), `content` (`"main"` article-only | `"full"` default), `include_links`, `include_metadata`, and `anchor` — plus cursor pagination via `offset_chars`/`limit_chars` (legacy `offset`/`limit` aliases accepted). Projection executes server-side in EnriProxy (same-day sanitizer entry).
- PDF responses append a conditional hint recommending the EnriVision `analyze_media` tool (when installed on the client) for multipass vision analysis.
- Every model-facing string (tool descriptions, parameter descriptions, errors, output headers) is Spanish per the monorepo convention; wire field names are unchanged.
- Requires an EnriProxy API key configured under `auth.api_key_policy.keys[*].key` in EnriProxy.
- `web_search` supports recency filters and allowlist/blocklist domain filters.
- `web_search` enriches results with verified latest stable + prerelease versions when registry URLs are detected (npm, PyPI, crates.io, NuGet, GitHub releases).
- Optional: `ENRIWEB_GITHUB_TOKEN` improves GitHub API rate limits for `web_search` enrichment.
- MCP tool descriptions intentionally avoid disclosing EnriProxy backend vendor names or fetch/search tier internals.
- `web_fetch` supports an optional extraction hint (`prompt`) and max content size control.
- `web_fetch` defaults `max_chars` to 200000 (configurable via `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS`) to reduce tool-output truncation risk in MCP clients.
- `web_fetch` supports cursor pagination (`cursor`, `offset_chars`, `limit_chars`) so large captures can be read in slices without re-fetching the URL; legacy aliases `offset` and `limit` are still accepted.
- `web_fetch` tolerates `limit=0` in URL fetch calls by treating it as omitted (pagination applies only to cursor reads).
- Documentation clarifies EnriProxy `web_fetch` tool-output defaults (`web.fetch.tool_preview_chars`) vs internal fetch preview limits (`web.fetch.preview_chars` / `web.fetch.capture_chars`).
- For `npmjs.com/package/...` URLs, `web_fetch` resolves npm metadata and fetches the GitHub repository README when available.
- Tool outputs do not include tier source metadata.
- README is aligned for npm/GitHub publishing under `@bedolla/enriweb` with updated installation, configuration, and parameter guidance.
- npm package now ships `README.md` (via `package.json` files list) for proper npmjs.com rendering.
- MCP tool schemas no longer expose per-call `server_url` or `api_key` overrides.

## Testing
- Ran: `npm test` (OK) - 4 files, 17 tests.
- Ran: `npm run build` (OK).
