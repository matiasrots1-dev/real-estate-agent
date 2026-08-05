#!/usr/bin/env node
// Escaneo de datos sensibles antes de cada commit (docs/TASKS.md, Bloque 13).
// Corre automáticamente vía el hook de git en .githooks/pre-commit — no
// depende de que alguien se acuerde de correrlo a mano. Motivo: dos números
// de teléfono reales del usuario llegaron a `main` en sesiones distintas de
// live testing (docs/TASKS.md, Bloques 10 y 12) porque nadie los escaneó
// antes de commitear.
//
// Bloquea el commit si encuentra:
//   - tokens con forma de credencial (Meta/Graph API, Anthropic, headers Bearer)
//   - URLs de túnel (Dev Tunnels, ngrok, Cloudflare Tunnel)
//   - números de teléfono reales, en archivos que NO son de test/mock
//     (los archivos de test/mock usan números ficticios a propósito, en
//     TODOS lados — quedan exentos de este chequeo puntual, si no cualquier
//     commit que tocara un test rompería)
//
// Uso manual: `npm run check:sensitive-data` (escanea lo staged) o
// `npm run check:sensitive-data -- --all` (escanea todo lo trackeado, útil
// para una auditoría puntual del estado actual del repo).
//
// Para saltear un falso positivo puntual: `git commit --no-verify` — con
// criterio, no de rutina (ver CONTRIBUTING.md).

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();

const CREDENTIAL_PATTERNS = [
  { name: "token de Meta/Graph API", re: /EAA[A-Za-z0-9]{15,}/g },
  { name: "token de Anthropic", re: /sk-ant-[A-Za-z0-9-]{15,}/g },
  { name: "header Bearer con valor", re: /Bearer [A-Za-z0-9._-]{15,}/g },
];

const TUNNEL_PATTERNS = [
  { name: "URL de Dev Tunnels", re: /[a-z0-9-]+\.[a-z]+\.devtunnels\.ms/gi },
  { name: "URL de ngrok", re: /[a-z0-9-]+\.ngrok(-free)?\.(io|app)/gi },
  { name: "URL de Cloudflare Tunnel", re: /[a-z0-9-]+\.trycloudflare\.com/gi },
];

const PHONE_PATTERNS = [
  { name: "teléfono argentino", re: /\+?54\d{9,11}\b/g },
  { name: "teléfono israelí", re: /\+?972\d{7,9}\b/g },
];

// Un número con una corrida de 4+ dígitos iguales seguidos (...0000...,
// ...5559999, ...9999999...) es, por convención de este proyecto, un
// placeholder a propósito, no un número real — ver docs/TASKS.md Bloques
// 8/10/12 para los ejemplos ya usados así. No los bloqueamos.
const FAKE_NUMBER_RUN = /(\d)\1{3,}/;

function isExemptFromPhoneCheck(filePath) {
  return /\.test\.[jt]sx?$/i.test(filePath) || /mock/i.test(filePath);
}

function listStagedFiles() {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACM"], {
    encoding: "utf-8",
  });
  return out.split("\n").filter(Boolean);
}

function listAllTrackedFiles() {
  const out = execFileSync("git", ["ls-files"], { encoding: "utf-8" });
  return out.split("\n").filter(Boolean);
}

function readStagedContent(filePath) {
  try {
    return execFileSync("git", ["show", `:${filePath}`], { encoding: "utf-8" });
  } catch {
    return null; // binario, borrado, o no legible como texto — no se escanea
  }
}

function readWorkingTreeContent(filePath) {
  try {
    return readFileSync(path.join(repoRoot, filePath), "utf-8");
  } catch {
    return null; // binario, borrado, o no legible como texto — no se escanea
  }
}

function findPatternMatches(content, patterns) {
  const found = [];
  for (const { name, re } of patterns) {
    const matches = [...content.matchAll(re)].map((m) => m[0]);
    if (matches.length > 0) found.push({ name, matches: [...new Set(matches)] });
  }
  return found;
}

function findPhoneMatches(content) {
  const found = [];
  for (const { name, re } of PHONE_PATTERNS) {
    const matches = [...content.matchAll(re)].map((m) => m[0]).filter((m) => !FAKE_NUMBER_RUN.test(m));
    if (matches.length > 0) found.push({ name, matches: [...new Set(matches)] });
  }
  return found;
}

function scanFile(filePath, readContent) {
  const content = readContent(filePath);
  if (content === null) return [];

  const hits = [
    ...findPatternMatches(content, CREDENTIAL_PATTERNS),
    ...findPatternMatches(content, TUNNEL_PATTERNS),
    ...(isExemptFromPhoneCheck(filePath) ? [] : findPhoneMatches(content)),
  ];
  return hits;
}

function main() {
  const auditMode = process.argv.includes("--all");
  const files = auditMode ? listAllTrackedFiles() : listStagedFiles();
  const readContent = auditMode ? readWorkingTreeContent : readStagedContent;

  let blocked = false;
  for (const file of files) {
    const hits = scanFile(file, readContent);
    if (hits.length === 0) continue;
    blocked = true;
    console.error(`\n✗ ${file}`);
    for (const hit of hits) {
      console.error(`  - ${hit.name}: ${hit.matches.join(", ")}`);
    }
  }

  if (blocked) {
    console.error(
      "\nSe detectaron posibles datos sensibles (ver arriba)." +
        (auditMode
          ? ""
          : " Commit bloqueado.\n" +
            "Si es un falso positivo real, usá un placeholder con una corrida de " +
            "4+ dígitos repetidos (ej. ...5559999) o pasá --no-verify a propósito, " +
            "con criterio (ver CONTRIBUTING.md).")
    );
    process.exit(1);
  }

  if (auditMode) console.log(`OK — ${files.length} archivos trackeados escaneados, sin coincidencias.`);
}

main();
