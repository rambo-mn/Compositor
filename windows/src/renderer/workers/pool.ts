// Heavy pixel work off the main thread: a few workers running the kernels by name (the Mac app's detached tasks).
import type { TaskName, TaskPayloads, TaskResults } from './tasks';

interface Pending { resolve: (value: unknown) => void; reject: (error: Error) => void }

export class Workers {
  private workers: Worker[] = [];
  private busy = new Map<Worker, number>();
  private pending = new Map<number, Pending & { worker: Worker }>();
  private nextID = 1;

  constructor(private readonly count = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))) {}

  private worker(): Worker {
    if (this.workers.length < this.count) {
      const worker = new Worker(new URL('./worker.js', document.baseURI), { type: 'module' });
      worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const job = this.pending.get(event.data.id);
        if (!job) return;
        this.pending.delete(event.data.id);
        this.busy.set(job.worker, (this.busy.get(job.worker) ?? 1) - 1);
        if (event.data.error !== undefined) job.reject(new Error(event.data.error));
        else job.resolve(event.data.result);
      };
      worker.onerror = (event) => {
        for (const [id, job] of this.pending) {
          if (job.worker !== worker) continue;
          this.pending.delete(id);
          job.reject(new Error(event.message || 'A background task failed.'));
        }
        this.busy.set(worker, 0);
      };
      this.workers.push(worker);
      this.busy.set(worker, 0);
      return worker;
    }
    return this.workers.reduce((best, w) => ((this.busy.get(w) ?? 0) < (this.busy.get(best) ?? 0) ? w : best));
  }

  /** Runs `task` in a worker. Buffers in `transfer` move to the worker (they are unusable here afterwards). */
  run<T extends TaskName>(task: T, payload: TaskPayloads[T], transfer: Transferable[] = []): Promise<TaskResults[T]> {
    const worker = this.worker();
    const id = this.nextID++;
    this.busy.set(worker, (this.busy.get(worker) ?? 0) + 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, worker });
      worker.postMessage({ id, task, payload }, transfer);
    });
  }
}
