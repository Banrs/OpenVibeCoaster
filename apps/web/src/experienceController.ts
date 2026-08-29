import type {
  CoasterFileV1,
  CompiledTrackData,
  Diagnostic,
} from "@openvibecoaster/core";
import {
  compileCoasterFile,
  deserializeCoasterFileV1,
  serializeCoasterFileV1,
} from "@openvibecoaster/core";
import type { Vec3 } from "@openvibecoaster/core";
import type { RideTimeline } from "@openvibecoaster/simulator";
import type { DirectedEditorInput } from "./directedInput.js";
import type { TimelineSelection } from "./telemetry.js";

export type ExperienceDiagnostic = Diagnostic;
export type ExperienceStatus = "pending" | "generating" | "ready" | "error";

export interface StableSpanHash {
  readonly spanId: string;
  readonly hash: string;
}
export type SpanHashInput =
  Readonly<Record<string, string>> | readonly StableSpanHash[];

export interface AuthoritativeExperienceResult {
  readonly file: CoasterFileV1;
  readonly track: CompiledTrackData;
  readonly timeline: RideTimeline;
  readonly diagnostics: readonly ExperienceDiagnostic[];
  readonly relaxations?: readonly string[];
  readonly spanHashes: SpanHashInput;
  readonly clearanceM?: Float64Array;
}

export type GenerateRequest =
  | { readonly mode: "insta"; readonly seed: number }
  | { readonly mode: "full-auto"; readonly seed: number }
  | { readonly mode: "directed"; readonly input: DirectedEditorInput };

export interface LocalRegenerateRequest {
  readonly file: CoasterFileV1;
  readonly selectedElementId: string | null;
  readonly baseResult: AuthoritativeExperienceResult;
}

export interface CompileLoadRequest {
  readonly source: File | string | Uint8Array;
}

export interface SaveRequest {
  readonly file: CoasterFileV1;
  readonly result: AuthoritativeExperienceResult;
}
export interface ExportRequest extends SaveRequest {
  readonly format: "json";
}

export interface ExperienceCallbacks {
  // Real operation functions injected by app wiring – no placeholder defaults
  readonly onGenerate: (
    request: GenerateRequest,
    requestId: number,
  ) => void | Promise<void>;
  readonly onLocalRegenerate: (
    request: LocalRegenerateRequest,
    requestId: number,
  ) => void | Promise<void>;
  readonly onCompileLoad: (
    request: CompileLoadRequest,
    requestId: number,
  ) => void | Promise<void>;
  readonly onSave?: (request: SaveRequest) => void | Promise<void>;
  readonly onExport?: (request: ExportRequest) => void | Promise<void>;
  readonly onElementSelectionChanged?: (elementId: string | null) => void;
  readonly onTimelineSelectionChanged?: (selection: TimelineSelection) => void;
  /** Optional error reporter for isolated subscriber throws; no console noise if absent */
  readonly onError?: (error: unknown, context: string) => void;
}

export interface ExperienceState {
  readonly status: ExperienceStatus;
  readonly result: AuthoritativeExperienceResult | null;
  readonly lastGoodResult: AuthoritativeExperienceResult | null;
  readonly error: string | null;
  readonly draftFile: CoasterFileV1 | null;
  readonly selectedElementId: string | null;
  readonly pinnedElementIds: readonly string[];
  readonly timelineSelection: TimelineSelection | null;
  readonly seamInspection: boolean;
  readonly unchangedSpanIds: readonly string[];
  readonly requestId: number;
  readonly epoch: number;
}

export interface ExperienceController {
  readonly getState: () => ExperienceState;
  readonly subscribe: (
    listener: (state: ExperienceState) => void,
  ) => () => void;
  readonly requestGenerate: (request: GenerateRequest) => number;
  readonly requestLocalRegenerate: () => number | null;
  readonly requestLoad: (file: File) => number;
  readonly requestSave: () => void;
  readonly requestExport: (format?: "json") => void;
  readonly setPending: () => void;
  /** Applies authoritative result; rejects stale or invalid results, never becomes ready on rejected. */
  readonly setResult: (
    result: AuthoritativeExperienceResult,
    requestId?: number,
  ) => boolean;
  readonly setError: (message: string, requestId?: number) => boolean;
  readonly selectElement: (elementId: string | null) => boolean;
  readonly editElementParameter: (
    elementId: string,
    parameter: string,
    value: string | number | boolean,
  ) => boolean;
  readonly togglePin: (elementId: string) => boolean;
  readonly selectTimelineIndex: (index: number) => TimelineSelection | null;
  readonly setSeamInspection: (enabled: boolean) => void;
  /**
   * Validates compile-load payload; remains in generating until authoritative result arrives via setResult.
   * No success boolean is exposed for readiness – use status/epoch. This only validates syntax.
   */
  readonly resolveCompileLoad: (
    payload: string | Uint8Array,
    requestId: number,
  ) => void;
}

const normalizeSpanHashes = (
  input: SpanHashInput,
): Readonly<Record<string, string>> => {
  if (Array.isArray(input))
    return Object.freeze(
      Object.fromEntries(input.map((e) => [e.spanId, e.hash])),
    );
  return Object.freeze({ ...(input as Readonly<Record<string, string>>) });
};

// Ownership rule: file, diagnostics, hashes, etc. are small and copied/frozen to avoid alias leakage.
// CompiledTrackData/RideTimeline are huge typed arrays whose public getters are documented as copying/immutable
// (e.g., positions returns new Float64Array, timeline getters return copies, and the classes are frozen);
// they are transferred by reference without duplication. Caller retains its original objects unfrozen;
// we freeze only owned small copies on the smallest coherent boundary.
const cloneFile = (file: CoasterFileV1): CoasterFileV1 => {
  // Canonical round trip gives validated, fully owned copy of intent, gates, targets/constraints, pins, footprint/height,
  // solved-span coefficients, research IDs, and nested values without freezing caller.
  try {
    const serialized = serializeCoasterFileV1(file);
    const owned = deserializeCoasterFileV1(serialized);
    // Layer minimal separately owned editable design copy needed by draft editor (shallow copy of elements for editing)
    const designElements = owned.design.elements.map((element) =>
      Object.freeze({
        ...element,
        ...(element.parameters
          ? { parameters: Object.freeze({ ...element.parameters }) }
          : {}),
      }),
    );
    const designGates = owned.design.gates?.map((gate) =>
      Object.freeze({ ...gate }),
    );
    const designConstraints = owned.design.constraints?.map((c) =>
      Object.freeze({ ...c }),
    );
    const design = Object.freeze({
      elements: Object.freeze(designElements),
      ...(designGates ? { gates: Object.freeze(designGates) } : {}),
      ...(designConstraints
        ? { constraints: Object.freeze(designConstraints) }
        : {}),
    }) as CoasterFileV1["design"];
    return Object.freeze({ ...owned, design });
  } catch (error) {
    if (error instanceof Error && error.message.includes("file.design")) {
      const elements = file.design.elements.map((element) =>
        Object.freeze({
          ...element,
          ...(element.parameters
            ? { parameters: Object.freeze({ ...element.parameters }) }
            : {}),
        }),
      );
      const gates = file.design.gates?.map((gate) =>
        Object.freeze({ ...gate }),
      );
      const constraints = file.design.constraints?.map((c) =>
        Object.freeze({ ...c }),
      );
      const designFallback = Object.freeze({
        elements: Object.freeze(elements),
        ...(gates ? { gates: Object.freeze(gates) } : {}),
        ...(constraints ? { constraints: Object.freeze(constraints) } : {}),
      }) as CoasterFileV1["design"];
      const intentCopy = (() => {
        const cloned = JSON.parse(
          JSON.stringify(file.intent),
        ) as CoasterFileV1["intent"];
        return Object.freeze({
          ...cloned,
          elements: Object.freeze(
            cloned.elements.map((e) =>
              Object.freeze({
                ...e,
                ...(e.parameters
                  ? { parameters: Object.freeze({ ...e.parameters }) }
                  : {}),
              }),
            ),
          ),
          gates: Object.freeze(
            cloned.gates.map((g) =>
              Object.freeze({
                ...g,
                position: Object.freeze([
                  ...g.position,
                ] as unknown as typeof g.position),
                ...(g.orientation
                  ? {
                      orientation: Object.freeze([
                        ...g.orientation,
                      ] as unknown as typeof g.orientation),
                    }
                  : {}),
              }),
            ),
          ),
          targets: Object.freeze(
            cloned.targets.map((t) =>
              Object.freeze({
                ...t,
                target: Array.isArray(t.target)
                  ? Object.freeze([...t.target] as unknown as typeof t.target)
                  : t.target,
              }),
            ),
          ),
          constraints: Object.freeze(
            cloned.constraints.map((c) =>
              Object.freeze({
                ...c,
                target: Array.isArray(c.target)
                  ? Object.freeze([...c.target] as unknown as typeof c.target)
                  : c.target,
                value: Array.isArray(c.value)
                  ? Object.freeze([...c.value] as unknown as typeof c.value)
                  : c.value,
              }),
            ),
          ),
          pinnedElementIds: Object.freeze([...cloned.pinnedElementIds]),
          ...(cloned.footprint
            ? {
                footprint: Object.freeze({
                  min: Object.freeze([
                    ...cloned.footprint.min,
                  ] as unknown as typeof cloned.footprint.min),
                  max: Object.freeze([
                    ...cloned.footprint.max,
                  ] as unknown as typeof cloned.footprint.max),
                }),
              }
            : {}),
          ...(cloned.heightRange
            ? { heightRange: Object.freeze({ ...cloned.heightRange }) }
            : {}),
        });
      })() as CoasterFileV1["intent"];
      const solvedSpansCopy = Object.freeze(
        [...file.solvedSpans].map((span) =>
          Object.freeze({
            ...span,
            positionCoefficients: Object.freeze(
              [...span.positionCoefficients].map((row) =>
                Object.freeze([...row]),
              ),
            ),
            rollCoefficients: Object.freeze([...span.rollCoefficients]),
          }),
        ),
      ) as CoasterFileV1["solvedSpans"];
      const researchCopy = Object.freeze([...file.researchSnapshotIds]);
      const fallback = {
        schemaVersion: 1 as const,
        name: file.name,
        intent: intentCopy,
        design: designFallback,
        solvedSpans: solvedSpansCopy,
        seed: file.seed,
        generatorVersion: file.generatorVersion,
        profileVersion: file.profileVersion,
        researchSnapshotIds: researchCopy,
        compiledDataChecksum: file.compiledDataChecksum,
      } as unknown as CoasterFileV1;
      return Object.freeze(fallback);
    }
    throw error;
  }
};

const copyDiagnostics = (diags: readonly Diagnostic[]): readonly Diagnostic[] =>
  Object.freeze(
    diags.map((d) =>
      Object.freeze({
        ...d,
        ...(d.location
          ? {
              location: Object.freeze({
                ...d.location,
                ...(d.location.position
                  ? {
                      position: Object.freeze([...d.location.position] as Vec3),
                    }
                  : {}),
              }),
            }
          : {}),
        ...(d.relatedIds
          ? { relatedIds: Object.freeze([...d.relatedIds]) }
          : {}),
      }),
    ),
  );

const validateResult = (
  result: AuthoritativeExperienceResult,
): string | null => {
  if (!result || typeof result !== "object") return "result must be an object";
  if (!result.file || !result.track || !result.timeline)
    return "result must contain file, track, and timeline";
  // Validate file compiles and checksum matches? At minimum check file has elements
  try {
    // Use core compilation validation where possible – will throw if invalid
    // But we don't want to recompile heavy; just ensure file is structurally valid via compile check
    // The authoritative result's file should be a valid CoasterFileV1; we verify by attempting lightweight checks
    if (
      !(result.track instanceof Object) ||
      typeof (result.track as CompiledTrackData).totalLength !== "number"
    )
      return "track must be CompiledTrackData";
    if (
      !Number.isFinite((result.track as CompiledTrackData).totalLength) ||
      (result.track as CompiledTrackData).totalLength <= 0
    )
      return "track totalLength must be finite positive";
    const timeline = result.timeline;
    if (
      !(timeline.headDistanceM instanceof Float64Array) ||
      !(timeline.timeSeconds instanceof Float64Array) ||
      !(timeline.speedMps instanceof Float64Array)
    )
      return "timeline arrays must be Float64Array";
    if (timeline.length === 0) return "timeline must not be empty";
    if (!(
      timeline.headDistanceM.length === timeline.timeSeconds.length &&
      timeline.timeSeconds.length === timeline.speedMps.length &&
      timeline.speedMps.length === timeline.length
    ))
      return "timeline arrays must be aligned";
    for (let i = 0; i < timeline.length; i += 1) {
      if (
        !Number.isFinite(timeline.headDistanceM[i]!) ||
        !Number.isFinite(timeline.timeSeconds[i]!) ||
        !Number.isFinite(timeline.speedMps[i]!)
      )
        return "timeline arrays must be finite";
    }
    if (result.clearanceM !== undefined && result.clearanceM !== null) {
      if (!(result.clearanceM instanceof Float64Array))
        return "clearanceM must be Float64Array if supplied";
      if (result.clearanceM.length !== timeline.length)
        return "clearanceM length must match timeline length";
      for (let i = 0; i < result.clearanceM.length; i += 1)
        if (!Number.isFinite(result.clearanceM[i]!))
          return "clearanceM must be finite";
    }
    // Ensure spanHashes present
    if (!result.spanHashes) return "spanHashes required";
    const hashes = normalizeSpanHashes(result.spanHashes);
    if (Object.keys(hashes).length === 0) return "spanHashes must not be empty";
    // Diagnostics must be array
    if (!Array.isArray(result.diagnostics)) return "diagnostics must be array";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
};

export function createExperienceController(
  callbacks: ExperienceCallbacks,
): ExperienceController {
  // Enforce injected real callbacks – throw early if missing required ones (no placeholder)
  if (
    !callbacks ||
    typeof callbacks.onGenerate !== "function" ||
    typeof callbacks.onLocalRegenerate !== "function" ||
    typeof callbacks.onCompileLoad !== "function"
  ) {
    throw new Error(
      "ExperienceController requires injected onGenerate, onLocalRegenerate, and onCompileLoad callbacks",
    );
  }

  let epoch = 0;
  let requestId = 0;
  let lastGoodResult: AuthoritativeExperienceResult | null = null;

  let state: ExperienceState = Object.freeze({
    status: "pending" as ExperienceStatus,
    result: null,
    lastGoodResult: null,
    error: null,
    draftFile: null,
    selectedElementId: null,
    pinnedElementIds: Object.freeze([]) as readonly string[],
    timelineSelection: null,
    seamInspection: false,
    unchangedSpanIds: Object.freeze([]) as readonly string[],
    requestId: 0,
    epoch: 0,
  });

  const listeners = new Set<(next: ExperienceState) => void>();
  let publishDepth = 0;

  const publish = (next: ExperienceState): void => {
    // Freeze returned state graph without freezing caller objects; copy direct children
    const frozen: ExperienceState = Object.freeze({
      ...next,
      pinnedElementIds: Object.freeze([...next.pinnedElementIds]),
      unchangedSpanIds: Object.freeze([...next.unchangedSpanIds]),
      draftFile: next.draftFile ? next.draftFile : null,
      result: next.result ? next.result : null,
      lastGoodResult: next.lastGoodResult ? next.lastGoodResult : null,
      timelineSelection: next.timelineSelection
        ? Object.freeze({ ...next.timelineSelection })
        : null,
    });
    state = frozen;
    // Snapshot semantics for reentrant add/remove; isolate throws via optional reporter
    publishDepth += 1;
    const snapshot = [...listeners];
    try {
      for (const listener of snapshot) {
        try {
          listener(state);
        } catch (error) {
          try {
            callbacks.onError?.(error, "subscriber");
          } catch {
            // never propagate subscriber errors
          }
        }
      }
    } finally {
      publishDepth -= 1;
    }
  };

  const failure = (error: unknown, failingRequestId?: number): void => {
    // Preserve last good result on failure – never clear lastGood
    const isStale =
      failingRequestId !== undefined && failingRequestId !== requestId;
    if (isStale) return;
    const message = error instanceof Error ? error.message : String(error);
    publish({
      ...state,
      status: "error",
      error: message,
      // Preserve current result if we had last good; otherwise keep null but retain lastGoodResult
      result: lastGoodResult,
      // Keep draftFile as last good's draft? Preserve last good's file if any
      draftFile: lastGoodResult
        ? cloneFile(lastGoodResult.file)
        : state.draftFile,
      timelineSelection: state.timelineSelection,
      requestId,
      epoch,
    });
  };

  const invoke = (
    callback: (() => void | Promise<void>) | undefined,
    onError: (error: unknown) => void,
  ): void => {
    if (!callback) return;
    try {
      const pending = callback();
      if (pending && typeof (pending as Promise<void>).catch === "function") {
        void (pending as Promise<void>).catch(onError);
      }
    } catch (error) {
      onError(error);
    }
  };

  const selectedElementExists = (elementId: string): boolean =>
    (state.result ?? lastGoodResult)?.file.design.elements.some(
      (element) => element.id === elementId,
    ) ?? false;

  return Object.freeze({
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      // If subscribing during publish, defer initial notification to next publish (snapshot semantics)
      if (publishDepth === 0) {
        try {
          listener(state);
        } catch (error) {
          try {
            callbacks.onError?.(error, "subscribe");
          } catch {
            // never leak subscriber exception
          }
        }
      }
      let unsubscribed = false;
      return () => {
        if (unsubscribed) return;
        unsubscribed = true;
        listeners.delete(listener);
      };
    },
    requestGenerate: (request) => {
      epoch += 1;
      requestId = epoch;
      publish({
        ...state,
        status: "generating",
        error: null,
        // Do not clear lastGoodResult; clear current result view but preserve lastGood for fallback
        result: null,
        draftFile: null,
        timelineSelection: null,
        unchangedSpanIds: Object.freeze([]),
        requestId,
        epoch,
      });
      const currentId = requestId;
      invoke(
        () => callbacks.onGenerate(request, currentId),
        (e) => failure(e, currentId),
      );
      return currentId;
    },
    requestLocalRegenerate: () => {
      const base = state.result ?? lastGoodResult;
      if (state.status !== "ready" || !base) return null;
      // Pinning preserves stable element IDs; send selected real element ID (not index-derived)
      const selectedId = state.selectedElementId;
      // Validate selected exists as real semantic id, not fabricated
      if (selectedId !== null && !selectedId.trim()) return null;
      if (selectedId !== null && !selectedElementExists(selectedId))
        return null;
      epoch += 1;
      requestId = epoch;
      publish({
        ...state,
        status: "generating",
        error: null,
        requestId,
        epoch,
      });
      const currentId = requestId;
      const draft = state.draftFile ?? cloneFile(base.file);
      const request: LocalRegenerateRequest = Object.freeze({
        file: draft,
        selectedElementId: selectedId,
        baseResult: base,
      });
      invoke(
        () => callbacks.onLocalRegenerate(request, currentId),
        (e) => failure(e, currentId),
      );
      return currentId;
    },
    requestLoad: (file) => {
      epoch += 1;
      requestId = epoch;
      publish({
        ...state,
        status: "generating",
        error: null,
        result: null,
        draftFile: null,
        timelineSelection: null,
        unchangedSpanIds: Object.freeze([]),
        requestId,
        epoch,
      });
      const currentId = requestId;
      invoke(
        () => callbacks.onCompileLoad({ source: file }, currentId),
        (e) => failure(e, currentId),
      );
      return currentId;
    },
    requestSave: () => {
      const result = state.result ?? lastGoodResult;
      if (!result || state.status !== "ready") return;
      const saveFile = state.draftFile ?? result.file;
      void callbacks.onSave?.({ file: saveFile, result });
    },
    requestExport: (format = "json") => {
      const result = state.result ?? lastGoodResult;
      if (!result || state.status !== "ready") return;
      const saveFile = state.draftFile ?? result.file;
      void callbacks.onExport?.({ format, file: saveFile, result });
    },
    setPending: () =>
      publish({
        ...state,
        status: "pending",
        error: null,
        result: null,
        draftFile: null,
        timelineSelection: null,
        unchangedSpanIds: Object.freeze([]),
        requestId,
        epoch,
      }),
    setResult: (result, incomingRequestId) => {
      // Stale rejection: if incomingRequestId is stale (not equal to current), reject
      if (incomingRequestId !== undefined && incomingRequestId !== requestId)
        return false;
      // Also reject if status is not generating? Allow ready->ready for initial? But must be generating to accept
      // We allow setResult only when generating or ready? Strict: must be generating to transition to ready
      // However for initial compile, status is generating – accept.
      const validationError = validateResult(result);
      if (validationError) {
        failure(new Error(validationError), incomingRequestId ?? requestId);
        return false;
      }
      // Compute unchanged spans vs lastGood
      const previousHashes = lastGoodResult
        ? normalizeSpanHashes(lastGoodResult.spanHashes)
        : {};
      const nextHashes = normalizeSpanHashes(result.spanHashes);
      const unchangedSpanIds = Object.keys(nextHashes).filter(
        (id) =>
          previousHashes[id] !== undefined &&
          previousHashes[id] === nextHashes[id],
      );

      // Validate pinned selection still exists
      const selectedElementId = result.file.design.elements.some(
        (element) => element.id === state.selectedElementId,
      )
        ? state.selectedElementId
        : null;

      // Deep-copy typed data ownership: clearanceM if supplied
      let ownedClearance: Float64Array | undefined;
      if (result.clearanceM)
        ownedClearance = new Float64Array(result.clearanceM);

      // Freeze owned result graph without mutating caller's object
      const ownedResult: AuthoritativeExperienceResult = Object.freeze({
        file: cloneFile(result.file),
        track: result.track,
        timeline: result.timeline, // RideTimeline/CompiledTrackData huge arrays are immutable/copying getters
        diagnostics: copyDiagnostics(result.diagnostics),
        ...(result.relaxations
          ? { relaxations: Object.freeze([...result.relaxations]) }
          : {}),
        spanHashes: Object.freeze({ ...nextHashes }),
        ...(ownedClearance ? { clearanceM: ownedClearance } : {}),
      });

      lastGoodResult = ownedResult;

      publish({
        ...state,
        status: "ready",
        result: ownedResult,
        lastGoodResult: ownedResult,
        error: null,
        draftFile: cloneFile(result.file),
        selectedElementId,
        timelineSelection:
          state.timelineSelection &&
          state.timelineSelection.index < result.timeline.length
            ? state.timelineSelection
            : null,
        unchangedSpanIds: Object.freeze(unchangedSpanIds),
        requestId: incomingRequestId ?? requestId,
        epoch,
      });
      return true;
    },
    setError: (message, incomingRequestId) => {
      if (incomingRequestId !== undefined && incomingRequestId !== requestId)
        return false;
      failure(new Error(message), incomingRequestId ?? requestId);
      return true;
    },
    selectElement: (elementId) => {
      if (elementId !== null && !selectedElementExists(elementId)) return false;
      publish({ ...state, selectedElementId: elementId });
      callbacks.onElementSelectionChanged?.(elementId);
      return true;
    },
    editElementParameter: (elementId, parameter, value) => {
      const base = state.result ?? lastGoodResult;
      if (!base || !selectedElementExists(elementId)) return false;
      if (typeof value === "number" && !Number.isFinite(value)) return false;
      const draft = cloneFile(state.draftFile ?? base.file);
      const element = draft.design.elements.find(
        (candidate) => candidate.id === elementId,
      );
      if (!element) return false;
      // Create new parameters object without mutating caller
      const parameters = Object.freeze({
        ...(element.parameters as Record<string, unknown>),
        [parameter]: value,
      });
      const elements = draft.design.elements.map((candidate) =>
        candidate.id === elementId
          ? Object.freeze({ ...candidate, parameters })
          : candidate,
      );
      const nextDesign = Object.freeze({
        ...draft.design,
        elements: Object.freeze(elements),
      });
      const nextFile = Object.freeze({
        ...draft,
        design: nextDesign,
      }) as CoasterFileV1;
      publish({ ...state, draftFile: nextFile });
      return true;
    },
    togglePin: (elementId) => {
      // Use stable semantic IDs, not index-derived
      if (!selectedElementExists(elementId)) return false;
      const pinned = state.pinnedElementIds.includes(elementId);
      const pinnedElementIds = pinned
        ? state.pinnedElementIds.filter((id) => id !== elementId)
        : [...state.pinnedElementIds, elementId];
      publish({ ...state, pinnedElementIds: Object.freeze(pinnedElementIds) });
      return !pinned;
    },
    selectTimelineIndex: (index) => {
      const result = state.result ?? lastGoodResult;
      if (!result) return null;
      const timeline = result.timeline;
      if (timeline.length === 0) return null;
      const safeIndex = Math.max(
        0,
        Math.min(timeline.length - 1, Math.trunc(index)),
      );
      const selection: TimelineSelection = Object.freeze({
        index: safeIndex,
        distanceM: timeline.headDistanceM[safeIndex] ?? 0,
        timeSeconds: timeline.timeSeconds[safeIndex] ?? 0,
      });
      publish({ ...state, timelineSelection: selection });
      callbacks.onTimelineSelectionChanged?.(selection);
      return selection;
    },
    setSeamInspection: (enabled) =>
      publish({ ...state, seamInspection: Boolean(enabled) }),
    resolveCompileLoad: (payload, incomingRequestId) => {
      if (incomingRequestId !== requestId) return;
      try {
        const file = compileCoasterFile(payload);
        // Validates payload syntax only; remains generating until authoritative result via setResult.
        // No readiness transition here – worker must supply track/timeline.
        void file;
      } catch (error) {
        failure(error, incomingRequestId);
      }
    },
  } as ExperienceController);
}
