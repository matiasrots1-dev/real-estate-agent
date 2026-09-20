import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Scheduler, type ScheduledJob } from "./scheduler.js";

function fakeJob(name: string, run = vi.fn(async () => {})): ScheduledJob {
  return { name, run };
}

describe("Scheduler", () => {
  it("tick corre todos los jobs registrados", async () => {
    const scheduler = new Scheduler({ intervalMs: 1000 });
    const job1 = fakeJob("job1");
    const job2 = fakeJob("job2");
    scheduler.register(job1);
    scheduler.register(job2);

    await scheduler.tick();

    expect(job1.run).toHaveBeenCalledTimes(1);
    expect(job2.run).toHaveBeenCalledTimes(1);
  });

  it("si un job falla, los demás igual corren", async () => {
    const scheduler = new Scheduler({ intervalMs: 1000 });
    const jobQueFalla = fakeJob(
      "falla",
      vi.fn(async () => {
        throw new Error("boom");
      })
    );
    const jobOk = fakeJob("ok");
    scheduler.register(jobQueFalla);
    scheduler.register(jobOk);

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(jobOk.run).toHaveBeenCalledTimes(1);
  });

  describe("start/stop", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("start corre un tick cada intervalMs, stop lo frena", async () => {
      const scheduler = new Scheduler({ intervalMs: 1000 });
      const job = fakeJob("job");
      scheduler.register(job);

      scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(job.run).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2000);
      expect(job.run).toHaveBeenCalledTimes(3);

      scheduler.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(job.run).toHaveBeenCalledTimes(3);
    });

    it("llamar start dos veces no duplica el intervalo", async () => {
      const scheduler = new Scheduler({ intervalMs: 1000 });
      const job = fakeJob("job");
      scheduler.register(job);

      scheduler.start();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(job.run).toHaveBeenCalledTimes(1);
    });
  });
});

// docs/TASKS.md Bloque 40. `setInterval` no espera a que termine la vuelta
// anterior: con una vuelta lenta —una llamada externa colgada— se apilaban
// los jobs, y dos corridas de la retención podían reescribir los mismos
// archivos a la vez. En el servidor no pasó nunca (el intervalo medido entre
// corridas nunca bajó de 290 s, con el scheduler en 300 s): esto cierra un
// riesgo de diseño.
describe("Scheduler — una vuelta no se superpone con la anterior", () => {
  it("si la vuelta anterior sigue corriendo, la siguiente se saltea", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const scheduler = new Scheduler({ intervalMs: 1000 });
    let soltar!: () => void;
    const retenido = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const corridas: number[] = [];
    scheduler.register(
      fakeJob(
        "lento",
        vi.fn(async () => {
          corridas.push(Date.now());
          await retenido;
        })
      )
    );

    const primera = scheduler.tick();
    await scheduler.tick(); // mientras la primera sigue colgada
    await scheduler.tick();

    expect(corridas).toHaveLength(1);
    expect(console.warn).toHaveBeenCalledTimes(2);

    soltar();
    await primera;

    // Terminada la anterior, la siguiente vuelta corre normalmente.
    await scheduler.tick();
    expect(corridas).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it("una vuelta en la que un job falla no deja el scheduler trabado", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const scheduler = new Scheduler({ intervalMs: 1000 });
    const job = fakeJob(
      "falla",
      vi.fn(async () => {
        throw new Error("boom");
      })
    );
    scheduler.register(job);

    await scheduler.tick();
    await scheduler.tick();

    expect(job.run).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
