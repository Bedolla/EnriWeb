# Changelog (EnriWeb)

## 0.1.10 (2026-09-18) — screenshots por defecto del servidor (auto)

EnriProxy ahora trata un `web_fetch` sin `screenshot` como `auto`: las páginas thin-text adjuntan capturas por defecto y EnriWeb las convierte en image blocks MCP como siempre. Sin cambios de parser (ausente sigue sin viajar por el wire — el default vive en el servidor); docs del param actualizadas ("none" = opt-out explícito para ahorrar tokens de visión). Tests nuevos: ausencia omite el campo en el wire; "none" explícito se reenvía (152/152). Nota de infra: el junction global npm de `@bedlla/enriweb` estaba roto; recreado manualmente (`New-Item -ItemType Junction` → checkout local, dist verificado).

## 0.1.9 (2026-09-18) — auditoría r1 vs contratos actuales de EnriProxy

Implementados los 7 hallazgos de la auditoría contra los contratos reales de EnriProxy (`/v1/tools/web_fetch` + `/v1/tools/web_search`). 0 rupturas (contrato aditivo), 5 faltantes de superficie y 2 de higiene:

- **screenshot end-to-end**: el tool `web_fetch` expone `screenshot` (`auto`/`force`/`none`, enum estricto en parser + inputSchema con costo documentado ~1,400 tokens de visión por segmento); `EnriProxyClient` lo envía en el body URL-mode; la respuesta tipa `screenshots[]`/`screenshot_status`/`screenshot_reason`; el server los convierte en **image content blocks MCP** (`splitScreenshotImages`) y `structuredContent` queda limpio (`screenshot_segments` en su lugar — el base64 jamás viaja por el canal JSON/texto). El formatter de texto nombra los segmentos o la razón de omisión para clientes sin visión. Solo lectura única completa por url pide capturas (cursor/ranges no).
- **fetch_note** (web_search): el proxy explica por qué `fetched_contents` está vacío/parcial; ahora se tipa, pasa al resultado y al texto (`WebSearchTool`), documentado en outputSchema.
- **outputSchema fetch**: añadidos `page_offset_chars`/`page_chars` (base sin decoraciones para ventanas de rango).
- **outputSchema search**: añadidos `searchPromptTruncated`/`searchPromptNotice`.
- **Errores**: 400 "Destino no permitido" (hosts privados) tiene guía dedicada en `translateKnownProxyMessage`.
- **Docs**: comentario de timeout en `index.ts` y README ya no dicen "480 s" (el default real es 300 s uniforme; se explica cómo extenderlo por env).

Tests: suite 142→150 (8 nuevos en `WebFetchScreenshotsAndNotes`: parser enum, wire field con servidor local real, notas del formatter, fetch_note, sin leak de base64 al texto). Typecheck + build limpios. Instalación global reinstalada desde el checkout (0.1.9).
