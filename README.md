# EnriWeb

EnriWeb is a **Model Context Protocol (MCP)** server over `stdio` that exposes **web search** and **URL fetching** tools by delegating execution to **EnriProxy**.

If your MCP client can call MCP tools, it can do web search / fetch in a consistent way without implementing provider-specific scraping logic.

## What this project is

- An MCP server process your MCP host launches (OpenCode, Claude Code, Codex, etc.)
- A thin client for EnriProxy (input validation + structured output)

## Requirements

- Node.js `>= 22` (recommended: Node 24 LTS)
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
- `ENRIWEB_TIMEOUT_MS` (`string`, optional, default: `60000`)
  - Parsed as an integer (milliseconds).
- `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS` (`string`, optional, default: `200000`)
  - Parsed as an integer.
- `ENRIWEB_GITHUB_TOKEN` (`string`, optional)
  - Used for GitHub API enrichment to improve rate limits.

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

- `query` (`string`, required): search query string.
- `max_results` (`number`, optional)
  - Must be `>= 1`.
  - If omitted, EnriProxy uses its configured default.
  - The upper limit is enforced server-side (EnriWeb does not hardcode a max).
- `recency` (`string`, optional, default: `noLimit`)
  - One of: `oneDay` | `oneWeek` | `oneMonth` | `oneYear` | `noLimit`
- `allowed_domains` (`string[]`, optional): allowlist of domains to include.
- `blocked_domains` (`string[]`, optional): blocklist of domains to exclude.
- `search_prompt` (`string`, optional): extra context to refine the search intent.

Example `arguments` object:

```jsonc
{
  "query": "qdrant docker compose autostart systemd",
  "max_results": 10,
  "recency": "oneMonth"
}
```

---

### `web_fetch`

Fetch and read content from a URL via EnriProxy.

Inputs:

- `url` (`string`, required unless `cursor` is provided): full URL (`http://` or `https://`).
- `cursor` (`string`, optional): opaque cursor returned by a previous `web_fetch` call.
- `offset_chars` (`number`, optional, default: `0`): cursor read offset in characters (`offset` is a legacy alias).
- `limit_chars` (`number`, optional): cursor read limit in characters (default: `max_chars`; `limit` is a legacy alias).
- `prompt` (`string`, optional): extraction hint (what to focus on).
- `max_chars` (`number`, optional): maximum content length (default: `ENRIWEB_WEB_FETCH_DEFAULT_MAX_CHARS`).
- `format` (`string`, optional): content flavor for HTML pages — `"text"` (default, lightweight structured text) or `"markdown"` (full markdown with links, emphasis, code fences, and images). Use markdown only when the exact page structure matters; text is cheaper for factual lookups.

Notes:

- If the response includes a `cursor`, you can page through the captured content by calling `web_fetch` again with `cursor` + `offset_chars` + `limit_chars`.

Example `arguments` object:

```jsonc
{
  "url": "https://example.com/docs",
  "max_chars": 200000
}
```

</details>
