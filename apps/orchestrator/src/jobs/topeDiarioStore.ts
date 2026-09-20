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
  /**
   * Cuándo salió el último mensaje. Lo usa el intervalo mínimo entre corridas
   * que envían: sin él, con el scheduler cada 5 minutos el tope diario se
   * agota en veinte minutos y parece un bot (docs/TASKS.md Bloque 27).
   */
  ultimaCorridaAt?: string;
}

export interface TopeDiarioStore {
  /** Cuántos se enviaron en la fecha dada. Cero si es otro día. */
  enviadosEn(dia: Date): Promise<number>;
  /**
   * Suma al contador del día y deja anotado cuándo fue. Las dos cosas van
   * juntas a propósito: son el mismo hecho —salió un mensaje— y separarlas
   * permitiría sumar sin anotar la hora, que es como el intervalo entre
   * corridas deja de existir sin que nada falle.
   */
  sumar(dia: Date, cuantos: number): Promise<void>;
  /**
   * Anota que la corrida hizo algo, sin sumar al contador. Lo usan los avisos
   * al broker: no son mensajes a clientes —no van al tope diario— pero sí
   * tienen que contar para el intervalo mínimo entre corridas. Sin esto, una
   * tanda de avisos cada 5 minutos le vuelca cientos al broker en un día
   * (revisión del PR #48).
   */
  registrarActividad(cuando: Date): Promise<void>;
  /** Cuándo salió el último mensaje o aviso, si salió alguno. */
  ultimaCorridaAt(): Promise<string | undefined>;
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
    this.estado = sumado(this.estado, dia, cuantos);
  }

  async registrarActividad(cuando: Date): Promise<void> {
    this.estado = { ...this.estado, ultimaCorridaAt: cuando.toISOString() };
  }

  async ultimaCorridaAt(): Promise<string | undefined> {
    return this.estado.ultimaCorridaAt;
  }
}

/**
 * El día cambia solo: si el registro es de ayer, el contador arranca de cero.
 * `ultimaCorridaAt` **no** se reinicia con el día — el intervalo entre corridas
 * cruza la medianoche como cualquier otro rato.
 */
function sumado(estado: TopeDiario, dia: Date, cuantos: number): TopeDiario {
  const clave = claveDeDia(dia);
  const enviados = estado.fecha === clave ? estado.enviados + cuantos : cuantos;
  return { fecha: clave, enviados, ultimaCorridaAt: dia.toISOString() };
}

// TODO(fase 2+): migrar a Postgres junto con el resto de los stores.
export class FileTopeDiarioStore implements TopeDiarioStore {
  constructor(private readonly filePath: string) {}

  async enviadosEn(dia: Date): Promise<number> {
    const estado = await readJsonFile<TopeDiario>(this.filePath, { fecha: "", enviados: 0 });
    return estado.fecha === claveDeDia(dia) ? estado.enviados : 0;
  }

  async sumar(dia: Date, cuantos: number): Promise<void> {
    const estado = await readJsonFile<TopeDiario>(this.filePath, { fecha: "", enviados: 0 });
    await writeJsonFile(this.filePath, sumado(estado, dia, cuantos));
  }

  async registrarActividad(cuando: Date): Promise<void> {
    const estado = await readJsonFile<TopeDiario>(this.filePath, { fecha: "", enviados: 0 });
    await writeJsonFile(this.filePath, { ...estado, ultimaCorridaAt: cuando.toISOString() });
  }

  async ultimaCorridaAt(): Promise<string | undefined> {
    return (await readJsonFile<TopeDiario>(this.filePath, { fecha: "", enviados: 0 })).ultimaCorridaAt;
  }
}
