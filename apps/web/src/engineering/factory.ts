import type { WorkerLike } from "./client";

// Vite 8 inline worker import — keeps OpenVibeCoaster.html offline with no subresource.
import EngineeringWorker from "./worker?worker&inline";

export function createEngineeringWorker(): WorkerLike {
  console.info("[ovc:diag] factory create start"); // DIAG-REMOVE
  const worker = new EngineeringWorker();
  console.info("[ovc:diag] factory create end"); // DIAG-REMOVE
  return worker as unknown as WorkerLike;
}

export function createEngineeringWorkerFactory(): () => WorkerLike {
  return () => createEngineeringWorker();
}
