# EnriWeb

EnriWeb is a **Model Context Protocol (MCP)** server over `stdio` that exposes **web search** and **URL fetching** tools by delegating execution to **EnriProxy**.

If your MCP client can call MCP tools, it can do web search / fetch in a consistent way without implementing provider-specific scraping logic.

## What this project is

- An MCP server process your MCP host launches (OpenCode, Claude Code, Codex, etc.)
- A thin client for EnriProxy (input validation + structured output)

## Requirements

- Node.js `>= 24` (Node 24 LTS)
- A reachable EnriProxy server with:
  - `POST /v1/tools/web_search`
  - `POST /v1/tools/web_fetch`
- An EnriProxy API key (configured on the EnriProxy side)

## Install

```powershell
# Global install
npm install -g @bedolla/enriweb

# Or run without installing
npx -y @bedolla/enriweb@latest --help
```

## Build

```powershell
npm install
npm run typecheck
npm run build
```

## Usage

### 1) Configure your MCP host

EnriWeb runs as an MCP server over `stdio`. Your MCP host is responsible for launching the process.

Example: global install

```jsonc
{
  "EnriWeb": {
    "type": "stdio",
    "command": "enriweb",
    "args": [],
    "env": {
      "ENRIPROXY_URL": "http://127.0.0.1:8787",
      "ENRIPROXY_API_KEY": "YOUR_ENRIPROXY_API_KEY"
    }
  }
}
```

Example: no install (always uses whatever npm currently tags as `latest`)

```jsonc
{
  "EnriWeb": {
    "type": "stdio",
    "command": "npx",
    "args": ["-y", "@bedolla/enriweb@latest"],
    "env": {
      "ENRIPROXY_URL": "http://127.0.0.1:8787",
      "ENRIPROXY_API_KEY": "YOUR_ENRIPROXY_API_KEY"
    }
  }
}
```

<details>
<summary>Use a local dev checkout</summary>

```jsonc
{
  "EnriWeb": {
    "type": "stdio",
    "command": "node",
    "args": ["C:\\\\Users\\\\Administrator\\\\Projects\\\\EnriWeb\\\\dist\\\\index.js"],
    "env": {
      "ENRIPROXY_URL": "http://127.0.0.1:8787",
      "ENRIPROXY_API_KEY": "YOUR_ENRIPROXY_API_KEY"
    }
  }
}
```

</details>

## Configuration

EnriWeb is configured via environment variables:

- `ENRIPROXY_URL` (`string`, optional, default: `http://127.0.0.1:8787`)
- `ENRIPROXY_API_KEY` (`string`, required)
- `ENRIWEB_TIMEOUT_MS` (`string`, optional, default: `300000`)
  - Parsed as an integer (milliseconds); fetch budget at double the proxy's total fetch budget (150 s) plus margin. Operator policy is a uniform 5-minute tool budget for both tools; when slow SearXNG engines are kept (server budget up to ~310 s), raise `ENRIWEB_SEARCH_TIMEOUT_MS` beyond the 300 s default.
- `ENRIWEB_SEARCH_TIMEOUT_MS` (`string`, optional, default: `300000`)
  - Parsed as an integer (milliseconds); uniform 5-minute tool budget. Residual: the SearXNG server budget alone can reach 310 s on slow-engine days, so searches slower than 300 s still end in the retryable timeout; raise the env var to extend it.
- `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS` (`string`, optional, default: `200000`, max `4000000`)
  - Parsed as an integer.
- `ENRIWEB_GITHUB_TOKEN` (`string`, optional)
  - Used for GitHub API enrichment to improve rate limits.
- `ENRIWEB_SCREENSHOT_MODE` (`string`, optional, one of `auto` | `force` | `none` | `analyze`)
  - Installation-level default for `web_fetch` screenshots, applied when the host omits the `screenshot` parameter (explicit host values always win). Designed for clients whose provider rejects image blocks inside tool results (OpenAI-compatible Chat Completions APIs accept images in user messages but not in tool messages — e.g. OpenCode surfaces "this model does not support image input" even for vision models). Set `analyze` on such installs: the server captures the page and returns a TEXT description per segment (`screenshot_analyses`) instead of image blocks. Invalid values warn on stderr and are ignored.
- `ENRIWEB_SEARCH_ENGINES` (`string`, optional, e.g. `google` or `google,bing`)
  - Operator SearXNG engine selector applied to every `web_search` call. Overrides the EnriProxy server default without reconfiguring the server; unset uses the server configuration. This is operator configuration on purpose — the model-facing `web_search` schema exposes no engine option so models cannot narrow their own results. Invalid values warn on stderr and are ignored.

## MCP tools

EnriWeb exposes these MCP tools:

- `web_search`
- `web_fetch`

<details>
<summary>Tool inputs (option-by-option)</summary>

General notes:

- All tools accept a single JSON object as their input (the MCP `arguments` for that tool).
- EnriWeb returns both:
  - a short human-readable preview (`content`)
  - the full result payload (`structuredContent`)

---

### `web_search`

Search the web via EnriProxy.

Inputs:

- `query` (`string` or `string[]`, required unless `queries` is provided): the search query. As an array it accepts a batch of 1 to 4 non-blank queries (each entry trimmed; duplicates collapse) — equivalent to sending `queries`.
- `queries` (`string[]`, optional): batch of 1 to 4 queries. Takes precedence over `query`. EnriProxy runs every query in parallel, merges results by relevance rank, and deduplicates by URL.
- `max_results` (`integer`, optional; alias `maxResults`)
  - Must be `>= 1`.
  - If omitted, EnriProxy uses its configured default.
  - The upper limit is enforced server-side (values above the limit are clamped to it).
- `recency` (`string`, optional, default: `noLimit`)
  - One of: `oneDay` | `oneWeek` | `oneMonth` | `oneYear` | `noLimit`
- `allowed_domains` (`string[]`, optional; alias `allowedDomains`): allowlist of domains to include.
- `blocked_domains` (`string[]`, optional; alias `blockedDomains`): blocklist of domains to exclude.
- `search_prompt` (`string`, optional; alias `searchPrompt`): extra context to refine the search intent. Capped at 2000 characters server-side (the excess is trimmed).

Outputs (`structuredContent`):

- `query` / `queries`: the executed query (or batch).
- `results[]`: entries with `url`, `title`, `snippet`, and `published_at` when available.
- `count`: number of returned results.
- `perQuery[]`: for batched searches, `{ query, urls }` attribution groups so each result can be traced back to the query that found it.
- `failedQueries[]`: queries that failed while at least one other succeeded (their section is absent from `perQuery`).
- `fetchedContents[]` / `fetchedCount`: when server-side auto-fetch is enabled, the verified content of the top result pages (`url`, `title`, `content`, `truncated`). Read these before concluding information is missing.
- `verified[]`: registry verification rows for npm / PyPI / crates.io / NuGet / GitHub URLs found in the results (`kind`, `name`, `latest_stable`, `latest_prerelease`, `status`, `error`).

Example `arguments` object:

```jsonc
{
  "queries": ["qdrant docker compose autostart", "qdrant container restart policy"],
  "max_results": 10,
  "recency": "oneMonth"
}
```

---

### `web_fetch`

Fetch and read content from a URL via EnriProxy.

Inputs:

- `url` (`string`, required unless `cursor` is provided): full URL (`http://` or `https://`).
- `cursor` (`string`, optional): opaque cursor returned by a previous `web_fetch` call. A valid cursor always wins over a coexisting `url`. Send `url` together with `cursor` whenever you know it: if the cursor expired server-side (TTL ~10 minutes), EnriWeb transparently re-fetches the url with the same parameters and returns fresh content with a new cursor (`recovered_from_expired_cursor`) instead of an error.
- `action` (`"delete"`, optional): releases the server-side capture owned by `cursor`. Send with `cursor`; other parameters are ignored. Responds `{ deleted, cursor }`.
- `ranges` (`array`, 1-10 items, optional): grouped `{ offset_chars, limit_chars }` windows read in one call. With `cursor`: each range is read server-side in parallel and the response is a grouped object (`range_applied`, `range_count`, `ranges[]`, `range_hint`). With `url`: the document is fetched first; if it arrives truncated with a cursor the ranges read that capture in parallel, otherwise they are sliced locally from the returned content.
- `offset_chars` (`integer`, optional, default: `0`; aliases `offsetChars` and legacy `offset`): read offset in characters. With `cursor`: server-side window over the capture. With `url` (first read): local slice over the returned content, like EnriCode.
- `limit_chars` (`integer`, optional, default: `max_chars`; aliases `limitChars` and legacy `limit`): read limit in characters. A value of `0` is ignored.
- `prompt` (`string`, optional): extraction hint (what to focus on).
- `max_chars` (`integer`, optional, default: `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS`; alias `maxChars`): maximum content length.
- `format` (`string`, optional): content flavor for HTML pages — `"text"` (default, lightweight structured text), `"markdown"` (full markdown with links, emphasis, code fences, images, and tables), or `"html"` (sanitized markup for DOM inspection — scripts/styles stripped, tags intact). Use markdown only when the exact page structure matters; text is cheaper for factual lookups.
- `content` (`string`, optional): HTML scope — `"main"` (default, article/main container only; drops nav, sidebars, cookie banners, and footers, typically saving 60-80% of tokens) or `"full"` (whole page).
- `include_links` (`boolean`, optional, default: `true`; alias `includeLinks`): append the `ENLACES DE LA PÁGINA` inventory with every unique link (label + URL, up to 200) — useful for informed crawling or handing image URLs to URL-capable media analysis tools. Send `false` to omit it.
- `include_metadata` (`boolean`, optional, default `false`; alias `includeMetadata`): append the `METADATOS DE LA PÁGINA` block with language, author, published date, and `og:image`.
- `anchor` (`string`, optional): section selector — element id (with or without `#`) or exact heading text; returns only that section up to the next same-or-higher heading. When the section is missing, the response says so and returns the full document.
- `screenshot` (`"auto" | "force" | "none" | "analyze"`, optional, per-call): page capture request. `"auto"` captures when the page looks visual, `"force"` always captures, `"none"` disables capture for this call, and `"analyze"` returns a TEXT description per screenshot segment (`screenshot_analyses`, server-side vision) instead of image blocks — designed for clients whose provider rejects image blocks inside tool results. Explicit per-call values always win over the installation-level `ENRIWEB_SCREENSHOT_MODE` default.

Outputs (`structuredContent`):

- Single read: `content`, `status`, `content_type`, `truncated`, `url`, and pagination fields when present (`cursor`, `offset_chars`, `limit_chars`, `total_chars`, `has_more`, `next_offset_chars`, `reduced`, `fetched_truncated`, `applied_max_chars` on the npm path).
- Delete: `deleted` (whether the cursor existed and was released) plus the addressed `cursor`.
- Grouped ranges: `range_applied: true`, `range_count`, `ranges[]` (per-range `index`, offsets, `content`, `truncated`, Spanish `error`/`note` rows), `range_hint`, and the backing `cursor`/`total_chars` when a capture exists.

Notes:

- If the response is truncated and includes a `cursor`, page through the captured content by calling `web_fetch` again with `cursor` + `offset_chars` + `limit_chars` (or a `ranges` batch for non-contiguous windows) — no re-download needed. Always echo the `url` on cursor calls: an expired cursor then recovers automatically (`recovered_from_expired_cursor: true`, fresh offsets, new cursor) instead of failing with HTTP 400.
- Exhausted captures are reclaimed automatically: when a read reports `has_more: false`, EnriWeb releases the server-side cursor best-effort, omits it from the result, and tells you the capture was fully read (a 10-minute TTL backstops anything left behind).
- npm package pages (`npmjs.com/package/<name>`, including `/v/<version>` pins and scoped packages) get a structured projection: registry metadata for the requested version plus the repository README, with pagination fields propagated when the README sub-fetch is truncated.
- EnriProxy-side URL controls travel glued to the URL and are documented in the tool description: `?enri_find=TEXT` (find text with offsets), `?enri_parts=` (select page sections), `?enri_body_offset=N&enri_body_limit=M` (body window), `?enri_section=` for YouTube (manifest/transcript/comments/description), and Drive/OneDrive folder listings.

Example `arguments` object:

```jsonc
{
  "url": "https://example.com/docs",
  "max_chars": 200000,
  "ranges": [
    { "offset_chars": 0, "limit_chars": 5000 },
    { "offset_chars": 120000, "limit_chars": 5000 }
  ]
}
```

</details>
