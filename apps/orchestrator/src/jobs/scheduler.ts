// Scheduler "cron simple" (docs/SOW.md secc. 4.6). Deliberadamente no es un
// cron de verdad (expresiones tipo "0 9 * * *"): los jobs de este proyecto
// (recordatorios, recontacto, seguimiento post-visita) son del tipo
// "chequeá cada tanto si ya se cumplió tal condición" (T-24h de una visita,
// N días sin respuesta), no "corré a tal hora exacta". Un polling simple a
// intervalo fijo cubre eso sin la complejidad de parsear cron expressions.
// Migrar a colas (BullMQ/Redis) queda para cuando el volumen real lo pida
// (docs/TASKS.md Bloque 11) — no antes.

export interface ScheduledJob {
  name: string;
  run(): Promise<void>;
}

export interface SchedulerOptions {
  intervalMs: number;
}

export class Scheduler {
  private readonly jobs: ScheduledJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: SchedulerOptions) {}

  register(job: ScheduledJob): void {
    this.jobs.push(job);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.options.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Corre todos los jobs registrados una vez. Un job que falla no frena a los demás. */
  async tick(): Promise<void> {
    for (const job of this.jobs) {
      try {
        await job.run();
      } catch (error) {
        console.error(`Job "${job.name}" falló:`, error);
      }
    }
  }
}
