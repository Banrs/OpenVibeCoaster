import type { DesignIntentV1 } from "@openvibecoaster/core";
import type {
  EngineeringWorkerRequest,
  EngineeringWorkerResponse,
  EngineeringWorkerSuccess,
} from "./protocol";
import {
  validateEngineeringWorkerRequest,
  validateEngineeringWorkerResponse,
} from "./protocol";

/**
 * Single-digit millisecond tolerance for tiny clock skew between worker
 * and main thread epoch-normalized clocks. Negative transfer raw values
 * within this window are clamped to 0; materially future worker timestamps
 * beyond the tolerance are treated as timing validation errors.
 */
const CLOCK_SKEW_TOLERANCE_MS = 5;

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
  // fallback properties
  onmessage?: ((ev: MessageEvent) => void) | null;
  onerror?: ((ev: Event) => void) | null;
  onmessageerror?: ((ev: MessageEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

export class EngineeringWorkerClient {
  private factory: WorkerFactory;
  private worker: WorkerLike | null = null;
  private epoch = 0;
  private pending = new Map<
    string,
    {
      resolve: (v: EngineeringWorkerSuccess) => void;
      reject: (e: Error) => void;
      epoch: number;
    }
  >();
  private terminated = false;
  private teardownOnce = false;

  private readonly messageHandler = (ev: Event) =>
    this.handleMessage(ev as MessageEvent);
  private readonly errorHandler = (ev: Event) => this.handleError(ev);
  private readonly messageErrorHandler = (ev: Event) => this.handleError(ev);

  public constructor(factory: WorkerFactory) {
    if (typeof factory !== "function")
      throw new Error("factory: expected function");
    this.factory = factory;
    try {
      this.worker = this.createWorker();
    } catch {
      this.worker = null;
    }
  }

  private createWorker(): WorkerLike {
    const w = this.factory();
    if (
      !w ||
      typeof w.postMessage !== "function" ||
      typeof w.terminate !== "function"
    ) {
      throw new Error("WorkerLike must implement postMessage and terminate");
    }
    if (w.addEventListener) {
      w.addEventListener("message", this.messageHandler as EventListener);
      w.addEventListener("error", this.errorHandler as EventListener);
      try {
        w.addEventListener(
          "messageerror",
          this.messageErrorHandler as EventListener,
        );
      } catch {
        // ignore
      }
    } else {
      (w as { onmessage?: unknown }).onmessage = this
        .messageHandler as unknown as (ev: MessageEvent) => void;
      (w as { onerror?: unknown }).onerror = this.errorHandler as unknown as (
        ev: Event,
      ) => void;
    }
    return w;
  }

  private getClientEpochMs(): number {
    const now =
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : Date.now();
    const origin =
      typeof performance !== "undefined" &&
      typeof performance.timeOrigin === "number" &&
      Number.isFinite(performance.timeOrigin)
        ? performance.timeOrigin
        : Date.now() - now;
    return origin + now;
  }

  private recordTimingMeasures(simulationMs: number, transferMs: number): void {
    if (
      typeof performance !== "undefined" &&
      typeof performance.measure === "function"
    ) {
      try {
        performance.measure("ovc:simulation", {
          duration: simulationMs,
        });
      } catch {
        // ignore measure errors — success must still settle
      }
      try {
        performance.measure("ovc:worker-transfer", {
          duration: transferMs,
        });
      } catch {
        // ignore — non-fatal to engineering success
      }
    }
  }

  private handleMessage(ev: MessageEvent): void {
    try {
      const receiptEpochMs = this.getClientEpochMs();
      const data = (ev as MessageEvent).data ?? (ev as unknown);
      const response = data as EngineeringWorkerResponse;
      if (
        !response ||
        typeof (response as { requestId?: unknown }).requestId !== "string"
      )
        return;
      const entry = this.pending.get(response.requestId);
      if (!entry) return; // stale ID
      if (entry.epoch !== this.epoch) {
        this.pending.delete(response.requestId);
        return; // old epoch
      }
      let validated: EngineeringWorkerResponse;
      try {
        validateEngineeringWorkerResponse(response);
        validated = response;
      } catch (err) {
        this.pending.delete(response.requestId);
        entry.reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.pending.delete(response.requestId);
      if (validated.type === "success") {
        const raw = receiptEpochMs - validated.timings.workerSendEpochMs;
        if (raw < -CLOCK_SKEW_TOLERANCE_MS) {
          const err = Object.assign(
            new Error(
              `Worker timestamp ${(-raw).toFixed(1)}ms in the future exceeds ${CLOCK_SKEW_TOLERANCE_MS}ms tolerance`,
            ),
            {
              code: "clock-skew",
              requestId: validated.requestId,
              rawTransferMs: raw,
            },
          );
          entry.reject(err);
          return;
        }
        const transferMs = raw < 0 ? 0 : raw;
        try {
          this.recordTimingMeasures(validated.timings.simulationMs, transferMs);
        } catch {
          // never throw from timing
        }
        entry.resolve(validated);
      } else if (validated.type === "failure") {
        const err = Object.assign(
          new Error(validated.diagnostics[0]?.message ?? "Engineering failure"),
          {
            diagnostics: validated.diagnostics,
            relaxations: validated.relaxations,
            requestId: validated.requestId,
            code: "failure",
          },
        );
        entry.reject(err);
      } else if (validated.type === "cancelled") {
        const err = Object.assign(
          new Error(`Request ${validated.requestId} cancelled`),
          {
            code: "cancelled",
            requestId: validated.requestId,
          },
        );
        entry.reject(err);
      } else {
        entry.reject(
          new Error(
            `Unknown response type ${(validated as { type: unknown }).type}`,
          ),
        );
      }
    } catch {
      // Never throw from event handler
    }
  }

  private handleError(ev: Event): void {
    try {
      const message =
        (ev as ErrorEvent).message ??
        (ev as { data?: unknown })?.data?.toString() ??
        "Worker error";
      // Reject all pending for current epoch
      for (const [id, entry] of this.pending.entries()) {
        if (entry.epoch !== this.epoch) continue;
        this.pending.delete(id);
        entry.reject(
          Object.assign(new Error(String(message)), {
            code: "worker-error",
            requestId: id,
          }),
        );
      }
      if (this.terminated) return;
      // Advance epoch and recreate worker for subsequent work
      let previousWorker: WorkerLike | null = null;
      try {
        previousWorker = this.worker;
        previousWorker?.terminate();
      } catch {
        // ignore
      }
      this.epoch += 1;
      this.worker = null;
      try {
        this.worker = this.createWorker();
      } catch {
        // Factory threw during recreate – never retain terminated worker, keep epoch advanced, reject already done; next operation will retry
        this.worker = null;
      }
      // Ensure terminated worker is not retained
      void previousWorker;
    } catch {
      // Never throw from event handler; ensure worker not retained if factory threw
      this.worker = null;
    }
  }

  private ensureWorker(): void {
    if (this.terminated) return;
    if (this.worker) return;
    try {
      this.worker = this.createWorker();
    } catch {
      this.worker = null;
    }
  }

  private enqueue(
    request: EngineeringWorkerRequest,
  ): Promise<EngineeringWorkerSuccess> {
    if (this.terminated) {
      return Promise.reject(
        Object.assign(new Error("Client terminated"), { code: "teardown" }),
      );
    }
    // Validate request shape synchronously to prove exact validation
    try {
      validateEngineeringWorkerRequest(request);
    } catch (err) {
      return Promise.reject(
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    const requestId = request.requestId;
    if (this.pending.has(requestId)) {
      return Promise.reject(new Error(`Duplicate requestId ${requestId}`));
    }
    this.ensureWorker();
    if (!this.worker) {
      return Promise.reject(
        Object.assign(new Error("Worker factory failed"), {
          code: "worker-factory",
          requestId,
        }),
      );
    }
    return new Promise<EngineeringWorkerSuccess>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject, epoch: this.epoch });
      try {
        this.worker?.postMessage(request);
      } catch (err) {
        this.pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public generate(
    requestId: string,
    intent: DesignIntentV1,
  ): Promise<EngineeringWorkerSuccess> {
    return this.enqueue({ type: "generate", requestId, intent });
  }

  public regenerate(
    requestId: string,
    file: unknown,
    elementId: string,
  ): Promise<EngineeringWorkerSuccess> {
    return this.enqueue({ type: "regenerate", requestId, file, elementId });
  }

  public compileSimulate(
    requestId: string,
    file: unknown,
  ): Promise<EngineeringWorkerSuccess> {
    return this.enqueue({ type: "compile-simulate", requestId, file });
  }

  // Alias for spec naming: compile-simulate hyphen
  public ["compile-simulate"](
    requestId: string,
    file: unknown,
  ): Promise<EngineeringWorkerSuccess> {
    return this.compileSimulate(requestId, file);
  }

  public cancel(requestId: string): void {
    try {
      if (this.terminated) return;
      if (typeof requestId !== "string" || requestId.trim().length === 0)
        return;
      const entry = this.pending.get(requestId);
      if (!entry) return; // cancel-after-response: ignore
      if (entry.epoch !== this.epoch) {
        this.pending.delete(requestId);
        return; // old epoch stale
      }
      const activeId = this.pending.keys().next().value as string | undefined;
      const isActive = activeId === requestId;
      if (isActive) {
        // Must terminate worker because synchronous engineering occupies event loop
        const w = this.worker;
        if (w) {
          try {
            w.removeEventListener?.(
              "message",
              this.messageHandler as EventListener,
            );
          } catch {}
          try {
            w.removeEventListener?.(
              "error",
              this.errorHandler as EventListener,
            );
          } catch {}
          try {
            w.removeEventListener?.(
              "messageerror",
              this.messageErrorHandler as EventListener,
            );
          } catch {}
          try {
            (w as { onmessage?: unknown }).onmessage = null;
          } catch {}
          try {
            (w as { onerror?: unknown }).onerror = null;
          } catch {}
          try {
            w.terminate();
          } catch {}
        }
        this.epoch += 1;
        this.pending.delete(requestId);
        entry.reject(
          Object.assign(new Error(`Request ${requestId} cancelled`), {
            code: "cancelled",
            requestId,
          }),
        );
        this.worker = null;
        if (!this.terminated) {
          try {
            this.worker = this.createWorker();
          } catch {
            this.worker = null;
          }
        }
      } else {
        // Queued (not active) — reject exactly that request without terminating
        this.pending.delete(requestId);
        entry.reject(
          Object.assign(new Error(`Request ${requestId} cancelled`), {
            code: "cancelled",
            requestId,
          }),
        );
        try {
          this.worker?.postMessage({
            type: "cancel",
            requestId,
          } as EngineeringWorkerRequest);
        } catch {}
      }
    } catch {
      // Synchronous cancel never throws
    }
  }

  public teardown(): void {
    if (this.teardownOnce) return;
    this.teardownOnce = true;
    this.terminated = true;
    for (const [id, entry] of this.pending.entries()) {
      entry.reject(
        Object.assign(new Error(`Client teardown: request ${id} cancelled`), {
          code: "teardown",
          requestId: id,
        }),
      );
    }
    this.pending.clear();
    if (this.worker) {
      try {
        this.worker.removeEventListener?.(
          "message",
          this.messageHandler as EventListener,
        );
      } catch {}
      try {
        this.worker.removeEventListener?.(
          "error",
          this.errorHandler as EventListener,
        );
      } catch {}
      try {
        this.worker.removeEventListener?.(
          "messageerror",
          this.messageErrorHandler as EventListener,
        );
      } catch {}
      try {
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
  }

  // Exposed for tests to prove lifecycle ownership
  public getEpoch(): number {
    return this.epoch;
  }
  public getPendingCount(): number {
    return this.pending.size;
  }
  public getWorker(): WorkerLike | null {
    return this.worker;
  }
  public isTerminated(): boolean {
    return this.terminated;
  }
}
