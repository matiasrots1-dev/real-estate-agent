import { readJsonFile, writeJsonFile } from "../agent/jsonFileStore.js";

/**
 * Cuántos recontactos se enviaron hoy.
 *
 * **Vive en disco, no en memoria, y eso es el punto entero.** Un contador en
 * memoria deja de ser un tope diario apenas alguien reinicia el proceso:
 * reiniciás tres veces y salieron treinta mensajes en un día con tope de diez,
 * sin que nada falle ni quede registrado. Es el modo de fallo que se rompe más
 * silenciosamente de todo este job.
 *
 * La fecha se guarda junto al conteo: al cambiar el día el contador arranca de
 * cero solo, sin necesidad de que nadie lo resetee.
 */
export interface TopeDiario {
  /** `YYYY-MM-DD` en hora local. */
  fecha: string;
  enviados: number;
}

export interface TopeDiarioStore {
  /** Cuántos se enviaron en la fecha dada. Cero si es otro día. */
  enviadosEn(dia: Date): Promise<number>;
  /** Suma al contador del día. */
  sumar(dia: Date, cuantos: number): Promise<void>;
}

/** Día calendario local, no UTC: el tope es "por día" en la cabeza del broker. */
export function claveDeDia(fecha: Date): string {
  const y = fecha.getFullYear();
  const m = String(fecha.getMonth() + 1).padStart(2, "0");
  const d = String(fecha.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export class InMemoryTopeDiarioStore implements TopeDiarioStore {
  private estado: TopeDiario = { fecha: "", enviados: 0 };

  async enviadosEn(dia: Date): Promise<number> {
    return this.estado.fecha === claveDeDia(dia) ? this.estado.enviados : 0;
  }

  async sumar(dia: Date, cuantos: number): Promise<void> {
    const clave = claveDeDia(dia);
    this.estado =
      this.estado.fecha === clave
        ? { fecha: clave, enviados: this.estado.enviados + cuantos }
        : { fecha: clave, enviados: cuantos };
  }
}

// TODO(fase 2+): migrar a Postgres junto con el resto de los stores.
export class FileTopeDiarioStore implements TopeDiarioStore {
  constructor(private readonly filePath: string) {}

  async enviadosEn(dia: Date): Promise<number> {
    const estado = await readJsonFile<TopeDiario>(this.filePath, { fecha: "", enviados: 0 });
    return estado.fecha === claveDeDia(dia) ? estado.enviados : 0;
  }

  async sumar(dia: Date, cuantos: number): Promise<void> {
    const clave = claveDeDia(dia);
    const estado = await readJsonFile<TopeDiario>(this.filePath, { fecha: "", enviados: 0 });
    const nuevo: TopeDiario =
      estado.fecha === clave ? { fecha: clave, enviados: estado.enviados + cuantos } : { fecha: clave, enviados: cuantos };
    await writeJsonFile(this.filePath, nuevo);
  }
}
