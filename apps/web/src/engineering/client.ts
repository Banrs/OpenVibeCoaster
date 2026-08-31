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

const CLOCK_SKEW_TOLERANCE_MS = 5;

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  addEventListener?(type: string, listener: EventListener): void;
  removeEventListener?(type: string, listener: EventListener): void;
  onmessage?: ((event: MessageEvent) => void) | null;
  onerror?: ((event: Event) => void) | null;
  onmessageerror?: ((event: MessageEvent) => void) | null;
}

export type WorkerFactory = () => WorkerLike;

type PendingEntry = {
  readonly request: EngineeringWorkerRequest;
  readonly resolve: (value: EngineeringWorkerSuccess) => void;
  readonly reject: (error: Error) => void;
  epoch: number;
  postedEpoch?: number;
};

type Transition = { readonly token: symbol; readonly epoch: number };
type TransitionState = readonly [Transition, WorkerBinding | null, number];
type ListenerTuple = readonly [type: string, listener: EventListener];
type PriorHandlers = readonly [
  WorkerLike["onmessage"],
  WorkerLike["onerror"],
  WorkerLike["onmessageerror"],
];
type WorkerBinding = {
  readonly worker: WorkerLike;
  readonly epoch: number;
  readonly listeners: readonly ListenerTuple[];
  readonly priorHandlers?: PriorHandlers;
};

const safely = (action: () => void): void => {
  try {
    action();
  } catch {}
};

const restoreHandlers = (worker: WorkerLike, prior: PriorHandlers): void => {
  safely(() => void Reflect.set(worker, "onmessage", prior[0]));
  safely(() => void Reflect.set(worker, "onerror", prior[1]));
  safely(() => void Reflect.set(worker, "onmessageerror", prior[2]));
};

const requestError = (
  code: string,
  requestId: string,
  message: string,
): Error => Object.assign(new Error(message), { code, requestId });

export class EngineeringWorkerClient {
  private readonly factory: WorkerFactory;
  private worker: WorkerLike | null = null;
  private binding: WorkerBinding | null = null;
  private epoch = 0;
  private readonly pending = new Map<string, PendingEntry>();
  private transition: Transition | null = null;
  private terminated = false;
  private teardownOnce = false;

  public constructor(factory: WorkerFactory) {
    if (typeof factory !== "function")
      throw new Error("factory: expected function");
    this.factory = factory;
    try {
      this.publish(this.createBinding(this.epoch));
    } catch {
      this.worker = null;
      this.binding = null;
    }
  }

  private createBinding(epoch: number): WorkerBinding {
    const worker = this.factory();
    if (
      !worker ||
      typeof worker.postMessage !== "function" ||
      typeof worker.terminate !== "function"
    )
      throw new Error("WorkerLike must implement postMessage and terminate");

    let binding: WorkerBinding;
    const current = (): boolean =>
      this.binding === binding && this.epoch === epoch && !this.terminated;
    const listeners: readonly ListenerTuple[] = [
      [
        "message",
        (event) => current() && this.handleMessage(event as MessageEvent),
      ],
      ["error", (event) => current() && this.handleWorkerError(event)],
      ["messageerror", (event) => current() && this.handleWorkerError(event)],
    ];

    if (worker.addEventListener && worker.removeEventListener) {
      const attached: ListenerTuple[] = [];
      try {
        for (const listener of listeners) {
          worker.addEventListener(listener[0], listener[1]);
          attached.push(listener);
        }
      } catch (error) {
        for (const listener of attached)
          safely(() => worker.removeEventListener!(listener[0], listener[1]));
        safely(() => worker.terminate());
        throw error;
      }
      binding = { worker, epoch, listeners };
      return binding;
    }

    const priorHandlers: PriorHandlers = [
      worker.onmessage,
      worker.onerror,
      worker.onmessageerror,
    ];
    try {
      worker.onmessage = listeners[0]![1] as (event: MessageEvent) => void;
      worker.onerror = listeners[1]![1] as (event: Event) => void;
      worker.onmessageerror = listeners[2]![1] as (event: MessageEvent) => void;
    } catch (error) {
      restoreHandlers(worker, priorHandlers);
      safely(() => worker.terminate());
      throw error;
    }
    binding = { worker, epoch, listeners, priorHandlers };
    return binding;
  }

  private publish(binding: WorkerBinding): void {
    this.binding = binding;
    this.worker = binding.worker;
  }

  private dispose(binding: WorkerBinding | null): void {
    if (!binding) return;
    const { worker } = binding;
    if (binding.priorHandlers) {
      restoreHandlers(worker, binding.priorHandlers);
    } else {
      for (const listener of binding.listeners)
        safely(() => worker.removeEventListener?.(listener[0], listener[1]));
    }
    safely(() => worker.terminate());
  }

  private beginTransition(): TransitionState {
    const oldBinding = this.binding;
    const oldEpoch = this.epoch;
    const transition = {
      token: Symbol("worker-transition"),
      epoch: oldEpoch + 1,
    };
    this.worker = null;
    this.binding = null;
    this.epoch = transition.epoch;
    this.transition = transition;
    return [transition, oldBinding, oldEpoch];
  }

  private isCurrent(transition: Transition): boolean {
    return this.transition === transition && !this.terminated && !this.worker;
  }

  private failReplacement(transition: Transition): void {
    if (!this.isCurrent(transition)) return;
    const entries = [...this.pending.entries()].filter(
      ([, entry]) => entry.epoch === transition.epoch,
    );
    for (const [id] of entries) this.pending.delete(id);
    this.transition = null;
    for (const [id, entry] of entries)
      entry.reject(requestError("worker-factory", id, "Worker factory failed"));
  }

  private replaceAndReplay(transition: Transition): void {
    let candidate: WorkerBinding;
    try {
      candidate = this.createBinding(transition.epoch);
    } catch {
      this.failReplacement(transition);
      return;
    }
    if (!this.isCurrent(transition)) {
      this.dispose(candidate);
      return;
    }
    this.publish(candidate);
    this.replay(transition, candidate);
  }

  private replay(transition: Transition, binding: WorkerBinding): void {
    while (
      this.transition === transition &&
      this.binding === binding &&
      !this.terminated
    ) {
      const next = [...this.pending.entries()].find(
        ([, entry]) =>
          entry.epoch === transition.epoch &&
          entry.postedEpoch !== transition.epoch,
      );
      if (!next) {
        this.transition = null;
        return;
      }
      const [id, entry] = next;
      entry.postedEpoch = transition.epoch;
      try {
        binding.worker.postMessage(entry.request);
      } catch (error) {
        if (this.pending.get(id) !== entry) continue;
        if (this.transition !== transition || this.binding !== binding) return;
        this.pending.delete(id);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleWorkerError(event: Event): void {
    try {
      const message =
        (event as ErrorEvent).message ??
        (event as { data?: unknown }).data?.toString() ??
        "Worker error";
      const [transition, oldBinding, oldEpoch] = this.beginTransition();
      const affected = [...this.pending.entries()].filter(
        ([, entry]) => entry.epoch === oldEpoch,
      );
      for (const [id] of affected) this.pending.delete(id);
      this.dispose(oldBinding);
      for (const [id, entry] of affected)
        entry.reject(
          requestError("worker-error", id, `worker-error: ${String(message)}`),
        );
      if (this.isCurrent(transition)) this.replaceAndReplay(transition);
    } catch {
      this.worker = null;
      this.binding = null;
    }
  }

  private clientEpochMs(): number {
    const now =
      typeof performance !== "undefined" && performance.now
        ? performance.now()
        : Date.now();
    const origin =
      typeof performance !== "undefined" &&
      Number.isFinite(performance.timeOrigin)
        ? performance.timeOrigin
        : Date.now() - now;
    return origin + now;
  }

  private recordTimings(simulationMs: number, transferMs: number): void {
    if (typeof performance === "undefined" || !performance.measure) return;
    const measures = [
      ["ovc:simulation", simulationMs],
      ["ovc:worker-transfer", transferMs],
    ] as const;
    for (const [name, duration] of measures)
      safely(() => performance.measure(name, { start: 0, duration }));
  }

  private handleMessage(event: MessageEvent): void {
    try {
      const receiptEpochMs = this.clientEpochMs();
      const response = (event.data ?? event) as EngineeringWorkerResponse;
      if (!response || typeof response.requestId !== "string") return;
      const entry = this.pending.get(response.requestId);
      if (!entry) return;
      if (entry.epoch !== this.epoch) {
        this.pending.delete(response.requestId);
        entry.reject(
          requestError(
            "epoch-mismatch",
            response.requestId,
            `Stale epoch for ${response.requestId}`,
          ),
        );
        return;
      }
      try {
        validateEngineeringWorkerResponse(response);
      } catch (error) {
        this.pending.delete(response.requestId);
        entry.reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.pending.delete(response.requestId);
      if (response.type === "success") {
        const transferMs = receiptEpochMs - response.timings.workerSendEpochMs;
        if (transferMs < -CLOCK_SKEW_TOLERANCE_MS) {
          entry.reject(
            Object.assign(
              requestError(
                "clock-skew",
                response.requestId,
                `Worker timestamp ${(-transferMs).toFixed(1)}ms in the future exceeds ${CLOCK_SKEW_TOLERANCE_MS}ms tolerance`,
              ),
              { rawTransferMs: transferMs },
            ),
          );
          return;
        }
        this.recordTimings(
          response.timings.simulationMs,
          Math.max(0, transferMs),
        );
        entry.resolve(response);
      } else if (response.type === "failure") {
        entry.reject(
          Object.assign(
            requestError(
              "failure",
              response.requestId,
              response.diagnostics[0]?.message ?? "Engineering failure",
            ),
            {
              diagnostics: response.diagnostics,
              relaxations: response.relaxations,
            },
          ),
        );
      } else {
        entry.reject(
          requestError(
            "cancelled",
            response.requestId,
            `Request ${response.requestId} cancelled`,
          ),
        );
      }
    } catch {}
  }

  private enqueue(
    request: EngineeringWorkerRequest,
  ): Promise<EngineeringWorkerSuccess> {
    if (this.terminated)
      return Promise.reject(
        requestError("teardown", request.requestId, "Client terminated"),
      );
    try {
      validateEngineeringWorkerRequest(request);
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    if (this.pending.has(request.requestId))
      return Promise.reject(
        new Error(`Duplicate requestId ${request.requestId}`),
      );

    return new Promise((resolve, reject) => {
      const entry: PendingEntry = {
        request,
        resolve,
        reject,
        epoch: this.epoch,
      };
      this.pending.set(request.requestId, entry);
      if (this.transition) return;
      if (!this.binding) {
        const transition = {
          token: Symbol("worker-retry"),
          epoch: this.epoch,
        };
        this.transition = transition;
        this.replaceAndReplay(transition);
        return;
      }
      entry.postedEpoch = this.epoch;
      try {
        this.binding.worker.postMessage(request);
      } catch (error) {
        if (this.pending.get(request.requestId) !== entry) return;
        this.pending.delete(request.requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public generate(requestId: string, intent: DesignIntentV1) {
    return this.enqueue({ type: "generate", requestId, intent });
  }

  public regenerate(requestId: string, file: unknown, elementId: string) {
    return this.enqueue({ type: "regenerate", requestId, file, elementId });
  }

  public compileSimulate(requestId: string, file: unknown) {
    return this.enqueue({ type: "compile-simulate", requestId, file });
  }

  public ["compile-simulate"](requestId: string, file: unknown) {
    return this.compileSimulate(requestId, file);
  }

  public cancel(requestId: string): void {
    try {
      if (this.terminated || !requestId.trim()) return;
      const entry = this.pending.get(requestId);
      if (!entry) return;
      if (entry.epoch !== this.epoch) {
        this.pending.delete(requestId);
        entry.reject(
          requestError("epoch-mismatch", requestId, `Stale ${requestId}`),
        );
        return;
      }
      const activeId = [...this.pending.entries()].find(
        ([, candidate]) => candidate.postedEpoch === this.epoch,
      )?.[0];
      this.pending.delete(requestId);
      if (activeId !== requestId) {
        entry.reject(
          requestError(
            "cancelled",
            requestId,
            `Request ${requestId} cancelled`,
          ),
        );
        if (entry.postedEpoch === this.epoch)
          safely(() => this.worker?.postMessage({ type: "cancel", requestId }));
        return;
      }

      const [transition, oldBinding, oldEpoch] = this.beginTransition();
      for (const candidate of this.pending.values())
        if (candidate.epoch === oldEpoch) {
          candidate.epoch = transition.epoch;
          delete candidate.postedEpoch;
        }
      this.dispose(oldBinding);
      entry.reject(
        requestError("cancelled", requestId, `Request ${requestId} cancelled`),
      );
      if (this.isCurrent(transition)) this.replaceAndReplay(transition);
    } catch {
      // Cancellation is synchronous and never throws.
    }
  }

  public teardown(): void {
    if (this.teardownOnce) return;
    this.teardownOnce = true;
    this.terminated = true;
    const entries = [...this.pending.entries()];
    const binding = this.binding;
    this.pending.clear();
    this.worker = null;
    this.binding = null;
    this.transition = null;
    this.dispose(binding);
    for (const [id, entry] of entries)
      entry.reject(
        requestError(
          "teardown",
          id,
          `Client teardown: request ${id} cancelled`,
        ),
      );
  }

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
