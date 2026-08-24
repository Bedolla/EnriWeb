/**
 * ENRIWEB MCP SERVER
 *
 * Implements a minimal MCP server (stdio transport) exposing:
 * - `web_search`
 * - `web_fetch`
 *
 * @module server/EnriWebServer
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";

import type { WebSearchTool } from "../tools/WebSearchTool.js";
import type { WebFetchTool } from "../tools/WebFetchTool.js";

/**
 * Configuration for {@link EnriWebServer}.
 */
export interface EnriWebServerConfig {
  /**
   * Server name reported via MCP.
   */
  readonly name: string;

  /**
   * Server version reported via MCP.
   */
  readonly version: string;

  /**
   * Web search tool implementation.
   */
  readonly webSearchTool: WebSearchTool;

  /**
   * Web fetch tool implementation.
   */
  readonly webFetchTool: WebFetchTool;
}

/**
 * MCP server exposing EnriWeb tools.
 */
export class EnriWebServer {
  /**
   * Underlying MCP server implementation.
   */
  private readonly server: Server;

  /**
   * Web search tool implementation.
   */
  private readonly webSearchTool: WebSearchTool;

  /**
   * Web fetch tool implementation.
   */
  private readonly webFetchTool: WebFetchTool;

  /**
   * Creates a new {@link EnriWebServer}.
   *
   * @param config - Server configuration
   */
  public constructor(config: EnriWebServerConfig) {
    this.webSearchTool = config.webSearchTool;
    this.webFetchTool = config.webFetchTool;

    this.server = new Server(
      { name: config.name, version: config.version },
      {
        capabilities: {
          tools: {
            listChanged: false
          }
        }
      }
    );

    this.registerToolHandlers();
  }

  /**
   * Connects the server to a transport and starts listening.
   *
   * @param transport - MCP transport (stdio)
   */
  public async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  /**
   * Registers tool list and tool call handlers.
   */
  private registerToolHandlers(): void {
    const tools = [
      this.getWebSearchToolDefinition(),
      this.getWebFetchToolDefinition()
    ];

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const toolName = request.params.name;
      const args = request.params.arguments ?? {};

      try {
        if (toolName === "web_search") {
          const params = this.webSearchTool.parseParams(args);
          const result = await this.webSearchTool.execute(params);
          return {
            isError: false,
            content: [{ type: "text", text: this.webSearchTool.formatOutput(result) }],
            structuredContent: result
          } satisfies CallToolResult;
        }

        if (toolName === "web_fetch") {
          const params = this.webFetchTool.parseParams(args);
          const result = await this.webFetchTool.execute(params);
          return {
            isError: false,
            content: [{ type: "text", text: this.webFetchTool.formatOutput(result) }],
            structuredContent: result
          } satisfies CallToolResult;
        }

        return {
          isError: true,
          content: [{ type: "text", text: `Herramienta desconocida: ${toolName}` }]
        } satisfies CallToolResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          isError: true,
          content: [{ type: "text", text: message }]
        } satisfies CallToolResult;
      }
    });
  }

  /**
   * Returns the JSON schema tool definition for `web_search`.
   *
   * @returns Tool definition
   */
  private getWebSearchToolDefinition(): Tool {
    return {
      name: "web_search",
      description:
        "Busca en la web mediante el servicio multi-nivel de EnriProxy.\n" +
        "\n" +
        "Cuándo usarla:\n" +
        "- Cuando necesite información actual, noticias o documentación.\n" +
        "- Cuando busque soluciones técnicas, APIs o ejemplos de código.\n" +
        "- Cuando necesite verificar datos o encontrar fuentes actualizadas.\n" +
        "\n" +
        "Características:\n" +
        "- Respaldo automático entre múltiples backends de búsqueda (detalles omitidos intencionalmente)\n" +
        "- Verificación automática de registros: enriquece los resultados con la última versión estable y prerelease cuando detecta URLs de registros (npm, PyPI, crates.io, NuGet, GitHub)\n" +
        "- Filtrado por dominios (allowlist/blocklist)\n" +
        "- Filtrado por recencia (día/semana/mes/año)\n" +
        "\n" +
        "Notas:\n" +
        "- Use consultas específicas para obtener mejores resultados.\n" +
        "- Use el filtro de recencia para información sensible al tiempo.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Consulta de búsqueda. Sea específico para obtener mejores resultados."
          },
          max_results: {
            type: "integer",
            description:
              "Máximo de resultados (>= 1). Si se omite, EnriProxy usa su valor configurado por defecto. El límite superior se aplica en el servidor."
          },
          recency: {
            type: "string",
            enum: ["oneDay", "oneWeek", "oneMonth", "oneYear", "noLimit"],
            description: "Filtra por recencia (por defecto: noLimit)."
          },
          allowed_domains: {
            type: "array",
            items: { type: "string" },
            description: "Devuelve sólo resultados de estos dominios."
          },
          blocked_domains: {
            type: "array",
            items: { type: "string" },
            description: "Excluye resultados de estos dominios."
          },
          search_prompt: {
            type: "string",
            description: "Contexto opcional para refinar la intención de búsqueda."
          }
        },
        required: ["query"]
      }
    };
  }

  /**
   * Returns the JSON schema tool definition for `web_fetch`.
   *
   * @returns Tool definition
   */
  private getWebFetchToolDefinition(): Tool {
    const defaultMaxChars = this.webFetchTool.getDefaultMaxChars();
    return {
      name: "web_fetch",
      description:
        "Obtiene y lee el contenido de una URL mediante el servicio multi-nivel de EnriProxy.\n" +
        "\n" +
        "Cuándo usarla:\n" +
        "- Cuando necesite leer el contenido completo de una página web.\n" +
        "- Cuando necesite acceder a documentación, artículos o archivos de código.\n" +
        "- Cuando métodos de fetch más simples fallen por protección anti-bot.\n" +
        "\n" +
        "Características:\n" +
        "- Detección de APIs de registros de paquetes (npm, PyPI)\n" +
        "- Fetch de archivos raw (GitHub raw, HuggingFace)\n" +
        "- Fetch robusto para sitios estáticos, dinámicos y protegidos (best-effort)\n" +
        "- Respaldo automático entre múltiples estrategias de recuperación (detalles omitidos intencionalmente)\n" +
        "\n" +
        "Notas:\n" +
        "- Proporcione la URL completa incluyendo protocolo (https://).\n" +
        `- El contenido se limita con el parámetro \`max_chars\` (por defecto: ${defaultMaxChars}).\n` +
        "- Si el resultado viene truncado e incluye un `cursor`, vuelva a llamar `web_fetch` con `cursor` + `offset_chars` + `limit_chars` para leer más sin volver a descargar.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "URL completa a obtener (http:// o https://)."
          },
          cursor: {
            type: "string",
            description:
              "Cursor opaco devuelto por una llamada previa de `web_fetch` para paginación. Nunca invente este valor."
          },
          prompt: {
            type: "string",
            description:
              "Pista opcional que describe qué desea extraer (la herramienta devuelve el contenido obtenido; no genera un resumen con IA)."
          },
          max_chars: {
            type: "integer",
            description: `Longitud máxima del contenido (por defecto: ${defaultMaxChars}).`
          },
          format: {
            type: "string",
            enum: ["text", "markdown"],
            description:
              "Formato del contenido para páginas HTML. 'text' (por defecto) devuelve texto estructurado ligero y gasta menos tokens. Use 'markdown' cuando necesite reproducir la estructura exacta de la página: enlaces con URL, énfasis, bloques de código, listas anidadas o imágenes. Para preguntas puntuales (versiones, precios, datos sueltos) deje el formato por defecto."
          },
          offset: {
            type: "integer",
            description:
              "Alias legado de offset_chars. Offset de lectura por cursor en caracteres (por defecto: 0)."
          },
          limit: {
            type: "integer",
            description:
              "Alias legado de limit_chars. Límite de lectura por cursor en caracteres (por defecto: max_chars)."
          },
          offset_chars: {
            type: "integer",
            description:
              "Offset de lectura por cursor en caracteres (por defecto: 0). Prefiera este nombre actual de campo de EnriProxy sobre offset."
          },
          limit_chars: {
            type: "integer",
            description:
              "Límite de lectura por cursor en caracteres (por defecto: max_chars). Prefiera este nombre actual de campo de EnriProxy sobre limit."
          }
        },
        anyOf: [{ required: ["url"] }, { required: ["cursor"] }]
      }
    };
  }
}
