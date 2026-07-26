// Cliente MCP genérico por stdio: spawnea un MCP server (mcp-tokko,
// mcp-gcal, mcp-weather) como proceso hijo y expone sus tools vía
// `callTool`. Los wrappers tipados por servidor (ej. `tokkoMcpClient.ts`)
// se construyen encima de esto, no repiten la conexión.

import { createRequire } from "node:module";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);

/** Resuelve el entrypoint de `tsx` en disco para correr un MCP server en TS sin build previo. */
function resolveTsxCliPath(): string {
  const tsxPackageJsonPath = require.resolve("tsx/package.json");
  return path.join(path.dirname(tsxPackageJsonPath), "dist/cli.mjs");
}

export interface McpServerTarget {
  /** Path al entrypoint .ts del MCP server (ej. mcp-servers/mcp-tokko/src/index.ts). */
  entryPath: string;
  cwd: string;
  env?: Record<string, string>;
}

export class McpToolClient {
  private client: Client | undefined;

  constructor(private readonly target: McpServerTarget) {}

  async connect(): Promise<void> {
    if (this.client) return;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolveTsxCliPath(), this.target.entryPath],
      cwd: this.target.cwd,
      env: { ...getInheritableEnv(), ...this.target.env },
    });
    const client = new Client({ name: "orchestrator", version: "0.1.0" });
    await client.connect(transport);
    this.client = client;
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
  }

  /**
   * Llama una tool y devuelve su resultado ya parseado como JSON. Todas
   * nuestras tools MCP devuelven `{ content: [{ type: "text", text: json }] }`
   * en éxito, o `{ isError: true, content: [{ text: mensaje }] }` en error
   * (ver tools/result.ts de cada mcp-server) — acá se traduce ese contrato
   * a un valor JS normal o una excepción.
   */
  async callTool<T = unknown>(name: string, args: object): Promise<T> {
    if (!this.client) throw new Error("McpToolClient no está conectado. Llamá a connect() primero.");
    const result = await this.client.callTool({ name, arguments: args as Record<string, unknown> });
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.[0]?.text ?? "null";
    if (result.isError) {
      throw new Error(`Tool "${name}" devolvió error: ${text}`);
    }
    return JSON.parse(text) as T;
  }
}

function getInheritableEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
}
