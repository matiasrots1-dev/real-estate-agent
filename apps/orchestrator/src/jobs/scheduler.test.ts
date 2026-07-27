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
