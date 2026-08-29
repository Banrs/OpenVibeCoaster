import type { WorkerLike } from "./client";

// Vite 8 inline worker import — keeps OpenVibeCoaster.html offline with no subresource.
// Verified syntax: `?worker&inline` inlines worker as base64 string, no Blob URL leak.
import EngineeringWorker from "./worker?worker&inline";

export function createEngineeringWorker(): WorkerLike {
  // EngineeringWorker is a Worker constructor produced by Vite
  const worker = new (EngineeringWorker as unknown as { new (): Worker })();
  return worker as unknown as WorkerLike;
}

export function createEngineeringWorkerFactory(): () => WorkerLike {
  return () => createEngineeringWorker();
}
