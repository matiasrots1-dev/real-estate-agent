#!/usr/bin/env node
// Flujo de autorización OAuth2 "local" para obtener un GOOGLE_REFRESH_TOKEN
// de una sola vez (docs/CLAUDE.md secc. 5 — calendario dedicado de Google
// Calendar). Se corre una única vez desde tu compu; el refresh token que
// imprime es lo que va en .env para que mcp-gcal pueda operar sin volver a
// pedir consentimiento.
//
// Uso: node infra/scripts/get_google_refresh_token.mjs
// (o: npm run auth:gcal, desde la raíz del repo)

import { createServer } from "node:http";
import { exec } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { google } from "googleapis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
dotenv.config({ path: path.join(repoRoot, ".env") });

const PORT = 8085;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error(
    "Faltan GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET en .env — completalos antes de correr este script."
  );
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent", // fuerza que Google reemita el refresh_token aunque ya hayas autorizado antes
  scope: SCOPES,
});

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {}); // best-effort; si falla, el usuario copia la URL a mano
}

console.log(`\nRedirect URI configurado: ${REDIRECT_URI}`);
console.log("(tiene que estar agregado tal cual en Google Cloud Console → tu OAuth Client → Authorized redirect URIs)\n");
console.log("Abriendo el navegador para autorizar. Si no se abre solo, pegá esta URL:\n");
console.log(authUrl + "\n");
openBrowser(authUrl);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== "/oauth2callback") {
    res.writeHead(404);
    res.end();
    return;
  }

  const error = url.searchParams.get("error");
  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Google devolvió un error: ${error}. Podés cerrar esta pestaña.`);
    console.error(`\nGoogle devolvió un error: ${error}`);
    server.close();
    process.exit(1);
    return;
  }

  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(400);
    res.end("Falta el parámetro code en el callback.");
    return;
  }

  try {
    const { tokens } = await oauth2Client.getToken(code);

    if (!tokens.refresh_token) {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("No se recibió un refresh token — revisá la terminal.");
      console.error(
        "\nGoogle no devolvió un refresh_token. Esto pasa típicamente si esta cuenta " +
          "ya había autorizado esta app antes (Google solo lo manda la primera vez, o " +
          "cuando forzás el consentimiento).\n" +
          "Solución: entrá a https://myaccount.google.com/permissions, sacá el acceso a " +
          "esta app (busca el nombre que le pusiste en Google Cloud Console), y volvé a " +
          "correr este script.\n"
      );
      server.close();
      process.exit(1);
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Listo! Ya podés cerrar esta pestaña y volver a la terminal.");

    console.log("\nListo. Agregá esta línea a tu .env:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  } catch (err) {
    console.error("\nError intercambiando el code por tokens:", err.message);
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Error intercambiando el código — revisá la terminal.");
  } finally {
    server.close();
    process.exit(0);
  }
});

server.listen(PORT);
