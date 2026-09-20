import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Lee un JSON de disco; si el archivo no existe todavía, devuelve `fallback`. */
export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/**
 * Escribe un JSON a disco, creando el directorio si hace falta. Sobrescribe
 * todo el archivo.
 *
 * **A un temporal y después `rename`** (docs/TASKS.md Bloque 41). Un
 * `writeFile` directo trunca primero y escribe después: un corte entre las dos
 * cosas —el `systemd stop` de un deploy, que pasa varias veces por día— deja
 * un JSON a medias, y `readJsonFile` tira al parsearlo. Estos archivos son el
 * estado de las conversaciones, el reloj de los 24 meses de la retención y lo
 * que destraba el silencio del Bloque 31: no hay forma de reconstruirlos.
 *
 * El `rename` dentro del mismo directorio es atómico: o está el archivo
 * viejo entero, o el nuevo entero. El temporal lleva pid y uuid porque puede
 * haber otro proceso escribiendo el mismo store (un script a mano en el
 * servidor), y dos temporales con el mismo nombre se pisan.
 */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmp, filePath);
  } catch (error) {
    // Si el rename falló, el archivo anterior sigue entero: lo único que hay
    // que limpiar es el temporal. Un fallo al limpiarlo no puede tapar el
    // error original.
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
