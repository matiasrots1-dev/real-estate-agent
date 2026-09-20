// docs/TASKS.md Bloque 41. Estos archivos son el estado de las conversaciones,
// el reloj de los 24 meses de la retención y lo que destraba el silencio del
// Bloque 31: si una escritura los deja a medias, no hay forma de
// reconstruirlos. `writeFile` directo trunca primero y escribe después.
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readJsonFile, writeJsonFile } from "./jsonFileStore.js";

/**
 * `rename` no se puede espiar sobre el modulo ESM, asi que se reemplaza con
 * un doble que falla cuando el test lo pide. Es el unico camino para probar
 * el caso que este repo ya sufrio: el antivirus con el archivo abierto hace
 * fallar el rename (esta documentado en el test del reporte de retencion).
 */
let renameFalla = false;
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    default: real,
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (renameFalla) throw new Error("EPERM: el antivirus lo tiene abierto");
      return real.rename(...args);
    },
  };
});

let dir: string;
let archivo: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "json-store-"));
  archivo = path.join(dir, "sub", "datos.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("writeJsonFile", () => {
  it("escribe, crea el directorio y se puede volver a leer", async () => {
    await writeJsonFile(archivo, { a: 1 });

    expect(await readJsonFile(archivo, null)).toEqual({ a: 1 });
  });

  it("no deja temporales dando vueltas", async () => {
    await writeJsonFile(archivo, { a: 1 });
    await writeJsonFile(archivo, { a: 2 });

    expect((await readdir(path.dirname(archivo))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  // El caso real de este repo: el antivirus con el archivo abierto hace
  // fallar el rename (está documentado en el test del reporte de retención).
  it("si el rename falla, el archivo anterior queda intacto y el temporal se limpia", async () => {
    await writeJsonFile(archivo, { a: "lo de antes" });
    renameFalla = true;

    await expect(writeJsonFile(archivo, { a: "lo nuevo" })).rejects.toThrow("EPERM");
    renameFalla = false;

    expect(await readJsonFile(archivo, null)).toEqual({ a: "lo de antes" });
    expect((await readdir(path.dirname(archivo))).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("readJsonFile", () => {
  it("devuelve el fallback si el archivo no existe", async () => {
    expect(await readJsonFile(archivo, { vacio: true })).toEqual({ vacio: true });
  });

  // A propósito: un JSON a medias es un problema que hay que ver, no algo que
  // se pueda tapar devolviendo el default y sobrescribiéndolo después.
  it("tira si el archivo existe pero está roto", async () => {
    await writeJsonFile(archivo, { a: 1 });
    await writeFile(archivo, '{"a":');

    await expect(readJsonFile(archivo, null)).rejects.toThrow();
  });
});
