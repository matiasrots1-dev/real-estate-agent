import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileTopeDiarioStore, InMemoryTopeDiarioStore } from "./topeDiarioStore.js";

const HOY = new Date("2026-08-25T15:00:00");
const MANANA = new Date("2026-08-26T09:00:00");

describe("tope diario", () => {
  let dir: string;
  let archivo: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "tope-"));
    archivo = path.join(dir, "tope_diario.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ESTE es el test que importa. Es el modo de fallo 2 del pre-mortem: un
  // contador en memoria deja de ser un tope diario apenas alguien reinicia el
  // proceso. Reiniciás tres veces y salieron 30 mensajes con tope de 10, sin
  // que falle nada ni quede registrado en ningún lado.
  it("NO se reinicia al reiniciar el proceso", async () => {
    const antesDelReinicio = new FileTopeDiarioStore(archivo);
    await antesDelReinicio.sumar(HOY, 7);

    // Una instancia nueva es lo que pasa cuando el proceso arranca de cero:
    // no comparte NADA en memoria con la anterior.
    const despuesDelReinicio = new FileTopeDiarioStore(archivo);

    expect(await despuesDelReinicio.enviadosEn(HOY)).toBe(7);
  });

  it("varios reinicios seguidos siguen acumulando, no reseteando", async () => {
    for (let i = 0; i < 5; i++) {
      const instanciaNueva = new FileTopeDiarioStore(archivo);
      await instanciaNueva.sumar(HOY, 2);
    }

    expect(await new FileTopeDiarioStore(archivo).enviadosEn(HOY)).toBe(10);
  });

  it("arranca en cero cuando cambia el día, sin que nadie lo resetee", async () => {
    const store = new FileTopeDiarioStore(archivo);
    await store.sumar(HOY, 10);

    expect(await store.enviadosEn(HOY)).toBe(10);
    expect(await store.enviadosEn(MANANA)).toBe(0);
  });

  it("sumar en un día nuevo no arrastra el conteo del anterior", async () => {
    const store = new FileTopeDiarioStore(archivo);
    await store.sumar(HOY, 8);
    await store.sumar(MANANA, 1);

    expect(await store.enviadosEn(MANANA)).toBe(1);
  });

  it("sin archivo previo devuelve cero en vez de romper", async () => {
    expect(await new FileTopeDiarioStore(archivo).enviadosEn(HOY)).toBe(0);
  });

  // La versión en memoria existe sólo para los tests. Se deja explícito que
  // NO sirve para producción, justamente porque no sobrevive un reinicio.
  it("la version en memoria SI se pierde al reiniciar (por eso no va en producción)", async () => {
    const store = new InMemoryTopeDiarioStore();
    await store.sumar(HOY, 7);

    expect(await new InMemoryTopeDiarioStore().enviadosEn(HOY)).toBe(0);
  });
});
