#!/usr/bin/env node
// Corre automáticamente en cada `npm install` (script "prepare" del
// package.json raíz) — así el escaneo de datos sensibles queda activo desde
// el primer `npm install` de cualquier colaborador nuevo, sin que nadie
// tenga que acordarse de configurarlo a mano. Ver CONTRIBUTING.md.
//
// Apunta git directamente a .githooks/ (versionado en el repo) en vez de
// copiar nada a .git/hooks/ (que no es versionado) — mismo mecanismo nativo
// que usan herramientas como husky por debajo (`core.hooksPath`), sin
// agregar una dependencia nueva para algo así de chico.

import { execFileSync } from "node:child_process";

try {
  execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  console.log("Git hooks configurados (.githooks) — escaneo de datos sensibles activo antes de cada commit.");
} catch {
  // No es un repo git (ej. build de un tarball) o git no está disponible —
  // no hacemos fallar el npm install por esto.
  console.warn("No se pudo configurar core.hooksPath (¿no es un repo git?) — el escaneo pre-commit no quedó activo.");
}
