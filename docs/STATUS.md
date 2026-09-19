# STATUS (EnriWeb)

## 2026-09-18 - 0.1.10 default auto del servidor - COMPLETE

Status: COMPLETE. Docs del param actualizadas al nuevo default `auto` del servidor; 2 tests de wire nuevos (ausencia omite el campo, "none" se reenvía); 152/152, tsc+build limpios; junction global npm reparado y verificado (0.1.10 + dist).

## 2026-09-18 - Auditoría r1 + screenshot surface - COMPLETE

Status: COMPLETE. Paridad con los contratos actuales de EnriProxy: param `screenshot` (auto/force/none) → wire → response tipada → image content blocks MCP con structuredContent limpio; `fetch_note` proyectado; outputSchemas completos (page bounds, searchPrompt, fetchNote); guía dedicada para destinos bloqueados; timeouts documentados a 300 s. Validation: 150/150 tests (8 nuevos), tsc + build limpios; global reinstall 0.1.9. Nets abiertos: e2e contra proxy vivo; validación estricta de outputSchema en clientes (no observable desde aquí).
