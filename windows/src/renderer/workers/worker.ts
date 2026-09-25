// A background worker: runs pixel kernels for the editor (see tasks.ts).
import { runTask, TaskName } from './tasks';

self.onmessage = (event: MessageEvent<{ id: number; task: TaskName; payload: never }>) => {
  const { id, task, payload } = event.data;
  try {
    const { result, transfer } = runTask(task, payload);
    (self as unknown as Worker).postMessage({ id, result }, transfer);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: error instanceof Error ? error.message : String(error) });
  }
};
