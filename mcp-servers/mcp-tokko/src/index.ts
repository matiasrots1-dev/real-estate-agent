import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { RealTokkoClient } from "./realTokkoClient.js";

/**
 * Confirma, ANTES de servir nada, que la key de Tokko autentica de verdad.
 *
 * Sin esto el modo de fallo es silencioso: la API devuelve 200 con el catálogo
 * público (7613 propiedades ajenas) cuando la key no se aplica, y el agente le
 * cita a los clientes propiedades de otras inmobiliarias con total confianza
 * (docs/tokko-api.md, secc. 1).
 *
 * Falla ruidoso y no arranca: un orchestrator que no levanta es un problema
 * visible en dos minutos; uno que levanta con datos ajenos no se nota hasta
 * que un cliente pregunta por una propiedad que no existe.
 */
async function verificarTokko(): Promise<void> {
  const apiKey = process.env.TOKKO_API_KEY;
  if (!apiKey?.trim()) return; // Sin key se usa el mock, y eso ya se anuncia.

  const cliente = new RealTokkoClient({ apiKey, baseUrl: process.env.TOKKO_API_BASE_URL });
  const r = await cliente.verificarAutenticacion();

  if (!r.ok) {
    throw new Error(
      `La key de Tokko NO está autenticando: ${r.motivo}. ` +
        `Con key: ${r.conKey} propiedades; sin key: ${r.sinKey}. ` +
        `Verificá que TOKKO_API_KEY sea correcta y que se mande como query param ` +
        `(el header Authorization NO autentica — ver docs/tokko-api.md).`
    );
  }

  // stderr y no stdout: en un server MCP por stdio, stdout es el canal del
  // protocolo JSON-RPC.
  console.error(`[mcp-tokko] autenticación verificada: ${r.conKey} propiedades en la cuenta.`);
}

async function main() {
  await verificarTokko();
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("mcp-tokko no pudo iniciar:", error);
  process.exit(1);
});
