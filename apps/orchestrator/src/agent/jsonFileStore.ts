import { mkdir, readFile, writeFile } from "node:fs/promises";
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

/** Escribe un JSON a disco, creando el directorio si hace falta. Sobrescribe todo el archivo. */
export async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
