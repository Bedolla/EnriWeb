# EnriWeb Changelog

All notable changes to EnriWeb are documented in this file.

## 2026-06-19
### Changed
- Bumped package version to `0.1.1` for npm publishing.
- Aligned the package Node.js engine requirement with the Enri runtime standard (`>=24`).
- Updated the `web_fetch` MCP schema to advertise current EnriProxy pagination names (`offset_chars`, `limit_chars`) while keeping legacy aliases (`offset`, `limit`) documented for compatibility.
### Testing
- Ran: `npm test` (OK) - 4 files, 17 tests.
- Ran: `npm run build` (OK).

## 2026-01-26
### Fixed
- `web_fetch` now accepts `limit=0` in URL fetch calls by treating it as omitted (models sometimes emit `limit: 0` even though pagination only applies to cursor reads).
### Testing
- Ran: `npm test` (OK) - 4 files, 17 tests.
- Ran: `npm run build` (OK)

## 2026-01-13
### Added
- `web_search` now enriches results with verified latest stable + prerelease versions when registry URLs are detected (npm, PyPI, crates.io, NuGet, GitHub releases).
- Added optional `ENRIWEB_GITHUB_TOKEN` env var to improve GitHub API rate limits for `web_search` enrichment.
### Security
- Removed vendor/back-end implementation details from MCP tool descriptions (e.g., specific search engines or fetch tier names).
### Testing
- Ran: `npm test` (OK) - 4 files, 16 tests.
- Ran: `npm run build` (OK)

## 2026-01-11
### Changed
- Clarified `web_fetch` documentation to distinguish EnriProxy tool-output defaults (`web.fetch.tool_preview_chars`) from internal fetch preview limits.
### Testing
- Ran: `npm test` (OK)
- Ran: `npm run build` (OK)

## 2026-01-09
### Changed
- Default `web_fetch` max_chars is now 512000 (configurable via `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS`) to match EnriProxy's default fetch preview size.
- Improved `web_fetch` behavior for `npmjs.com/package/...` URLs by resolving npm metadata and fetching the GitHub repository README when available.
- Updated `web_fetch` human-readable output to show a short preview instead of duplicating the full fetched content.
- Clarified `web_fetch.prompt` as an extraction hint (not a tool-side AI summarizer).
### Testing
- Ran: `npm test` (OK)
- Ran: `npm run build` (OK)

## 2026-01-10
### Changed
- Default `web_fetch` max_chars is now 200000 (configurable via `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS`) to better align with MCP tool-result output limits.
- `web_fetch` now supports cursor-based pagination (`cursor`, `offset`, `limit`) when the upstream response is truncated or reduced.

## 2026-01-08
### Changed
- Packaged `README.md` for npm publishing (via `package.json` files list).
- Removed unverified token estimates from MCP tool descriptions; the `max_chars` parameter remains the source of truth for output size.
- Refreshed README with production and development MCP configuration examples.

## 2026-01-07
### Added
- Initial EnriWeb MCP server exposing `web_search` and `web_fetch` tools via EnriProxy endpoints.
- EnriProxy client, tool validation, and formatted outputs for web search/fetch.
- Unit tests for tool parameter parsing plus EnriProxy client error handling and request payloads.
### Changed
- Client-facing tool outputs no longer include tier source metadata.
- Updated npm publishing references to use the @bedolla/enriweb scope and refreshed README examples.
- Clarified README parameter descriptions for web_search and web_fetch.
- Removed per-call server_url/api_key overrides from MCP schemas, tools, and docs.
