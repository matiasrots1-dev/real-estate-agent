import { describe, expect, it, vi } from "vitest";
import { LruMessageDeduplicator } from "./messageDedup.js";

describe("LruMessageDeduplicator", () => {
  it("deja pasar la primera vez y descarta las siguientes", () => {
    const dedup = new LruMessageDeduplicator({ onDuplicado: () => {} });

    expect(dedup.registrarSiEsNuevo("wamid.A")).toBe(true);
    expect(dedup.registrarSiEsNuevo("wamid.A")).toBe(false);
    expect(dedup.registrarSiEsNuevo("wamid.A")).toBe(false);
    expect(dedup.duplicadosDescartados()).toBe(2);
  });

  it("no confunde ids distintos", () => {
    const dedup = new LruMessageDeduplicator({ onDuplicado: () => {} });

    expect(dedup.registrarSiEsNuevo("wamid.A")).toBe(true);
    expect(dedup.registrarSiEsNuevo("wamid.B")).toBe(true);
    expect(dedup.duplicadosDescartados()).toBe(0);
    expect(dedup.size()).toBe(2);
  });

  // Modo de fallo 1 del pre-mortem. Es sincrónico justamente para que esto no
  // pueda pasar: si chequear y marcar fueran dos `await`, dos reintentos
  // simultáneos de Meta pasarían los dos.
  it("chequear y marcar es una sola operación indivisible", () => {
    const dedup = new LruMessageDeduplicator({ onDuplicado: () => {} });

    const resultados = Array.from({ length: 50 }, () => dedup.registrarSiEsNuevo("wamid.storm"));

    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(dedup.duplicadosDescartados()).toBe(49);
  });

  describe("ante la duda, procesa", () => {
    // Modo de fallo 2: un falso positivo deja al cliente sin respuesta para
    // siempre y no se nota. Un duplicado de más sólo molesta.
    it("un id vacío o en blanco nunca se descarta", () => {
      const dedup = new LruMessageDeduplicator({ onDuplicado: () => {} });

      expect(dedup.registrarSiEsNuevo("")).toBe(true);
      expect(dedup.registrarSiEsNuevo("")).toBe(true);
      expect(dedup.registrarSiEsNuevo("   ")).toBe(true);
      expect(dedup.registrarSiEsNuevo("   ")).toBe(true);
      expect(dedup.duplicadosDescartados()).toBe(0);
    });

    it("un id ausente por payload raro tampoco rompe ni descarta", () => {
      const dedup = new LruMessageDeduplicator({ onDuplicado: () => {} });

      expect(dedup.registrarSiEsNuevo(undefined as unknown as string)).toBe(true);
      expect(dedup.registrarSiEsNuevo(null as unknown as string)).toBe(true);
    });

    it("si el callback de logueo explota, el mensaje se procesa igual", () => {
      const dedup = new LruMessageDeduplicator({
        onDuplicado: () => {
          throw new Error("el logger está roto");
        },
      });

      dedup.registrarSiEsNuevo("wamid.A");
      expect(() => dedup.registrarSiEsNuevo("wamid.A")).not.toThrow();
    });
  });

  describe("techo de memoria", () => {
    it("no crece más allá de su capacidad", () => {
      const dedup = new LruMessageDeduplicator({ capacidad: 10, onDesalojo: () => {} });

      for (let i = 0; i < 100; i++) dedup.registrarSiEsNuevo(`wamid.${i}`);

      expect(dedup.size()).toBe(10);
    });

    it("desaloja el más viejo, no el más reciente", () => {
      const dedup = new LruMessageDeduplicator({
        capacidad: 3,
        onDuplicado: () => {},
        onDesalojo: () => {},
      });

      dedup.registrarSiEsNuevo("viejo");
      dedup.registrarSiEsNuevo("b");
      dedup.registrarSiEsNuevo("c");
      dedup.registrarSiEsNuevo("nuevo"); // desaloja a "viejo"

      expect(dedup.registrarSiEsNuevo("nuevo")).toBe(false);
      expect(dedup.registrarSiEsNuevo("viejo")).toBe(true); // ya no lo recuerda
    });

    // Un reintento que llega tarde tiene que mantener vivo su id: si Meta
    // reintenta cinco veces, cada reintento lo aleja del desalojo en vez de
    // dejarlo envejecer.
    it("un duplicado refresca la posición del id", () => {
      const dedup = new LruMessageDeduplicator({
        capacidad: 3,
        onDuplicado: () => {},
        onDesalojo: () => {},
      });

      dedup.registrarSiEsNuevo("A");
      dedup.registrarSiEsNuevo("B");
      dedup.registrarSiEsNuevo("C");
      dedup.registrarSiEsNuevo("A"); // duplicado: A pasa a ser el más reciente
      dedup.registrarSiEsNuevo("D"); // desaloja a B, que ahora es el más viejo

      expect(dedup.registrarSiEsNuevo("A")).toBe(false); // sigue recordado
      expect(dedup.registrarSiEsNuevo("B")).toBe(true); // fue el desalojado
    });

    it("avisa una sola vez cuando empieza a desalojar", () => {
      const onDesalojo = vi.fn();
      const dedup = new LruMessageDeduplicator({ capacidad: 2, onDesalojo });

      for (let i = 0; i < 20; i++) dedup.registrarSiEsNuevo(`wamid.${i}`);

      expect(onDesalojo).toHaveBeenCalledTimes(1);
      expect(onDesalojo).toHaveBeenCalledWith(2);
    });
  });

  describe("señal de diagnóstico", () => {
    it("informa el id y el acumulado en cada descarte", () => {
      const onDuplicado = vi.fn();
      const dedup = new LruMessageDeduplicator({ onDuplicado });

      dedup.registrarSiEsNuevo("wamid.A");
      dedup.registrarSiEsNuevo("wamid.A");
      dedup.registrarSiEsNuevo("wamid.A");

      expect(onDuplicado).toHaveBeenNthCalledWith(1, "wamid.A", 1);
      expect(onDuplicado).toHaveBeenNthCalledWith(2, "wamid.A", 2);
    });

    it("el log por defecto no incluye teléfono ni texto, sólo el wamid", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const dedup = new LruMessageDeduplicator();

      dedup.registrarSiEsNuevo("wamid.HBgNNTQ5");
      dedup.registrarSiEsNuevo("wamid.HBgNNTQ5");

      const linea = String(warn.mock.calls[0]?.[0]);
      expect(linea).toContain("wamid.HBgNNTQ5");
      expect(linea).toContain("van 1");
      warn.mockRestore();
    });
  });
});
