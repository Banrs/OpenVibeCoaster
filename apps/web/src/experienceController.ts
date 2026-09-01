import type { CoasterFileV1, Diagnostic } from "@openvibecoaster/core";
import {
  CompiledTrackData,
  compileCoasterFile,
  createCoasterFileV1,
  createDesignIntentV1,
  deserializeCoasterFileV1,
  serializeCoasterFileV1,
} from "@openvibecoaster/core";
import type { DesignIntentV1, Vec3 } from "@openvibecoaster/core";
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
  readonly clearanceM: Float64Array;
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
const cloneFile = (file: CoasterFileV1): CoasterFileV1 =>
  deserializeCoasterFileV1(serializeCoasterFileV1(file));

const rebuildFileWithIntent = (
  baseFile: CoasterFileV1,
  newIntent: DesignIntentV1,
): CoasterFileV1 =>
  cloneFile(
    createCoasterFileV1({
      name: baseFile.name,
      intent: newIntent,
      solvedSpans: [...baseFile.solvedSpans],
      seed: baseFile.seed,
      generatorVersion: baseFile.generatorVersion,
      profileVersion: baseFile.profileVersion,
      researchSnapshotIds: [...baseFile.researchSnapshotIds],
      compiledDataChecksum: baseFile.compiledDataChecksum,
    }),
  );

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
  try {
    if (!(result.track instanceof CompiledTrackData)) {
      return "track must be CompiledTrackData instance";
    }
    if (
      !Number.isFinite(result.track.totalLength) ||
      result.track.totalLength <= 0
    )
      return "track totalLength must be finite positive";
    const timeline = result.timeline;
    const headDistanceM = timeline.headDistanceM;
    const timeSeconds = timeline.timeSeconds;
    const speedMps = timeline.speedMps;
    if (
      !(headDistanceM instanceof Float64Array) ||
      !(timeSeconds instanceof Float64Array) ||
      !(speedMps instanceof Float64Array)
    )
      return "timeline arrays must be Float64Array";
    if (timeline.length === 0) return "timeline must not be empty";
    if (!(
      headDistanceM.length === timeSeconds.length &&
      timeSeconds.length === speedMps.length &&
      speedMps.length === timeline.length
    ))
      return "timeline arrays must be aligned";
    for (let i = 0; i < timeline.length; i += 1) {
      if (
        !Number.isFinite(headDistanceM[i]!) ||
        !Number.isFinite(timeSeconds[i]!) ||
        !Number.isFinite(speedMps[i]!)
      )
        return "timeline arrays must be finite";
    }
    if (!(result.clearanceM instanceof Float64Array))
      return "clearanceM must be Float64Array";
    if (result.clearanceM.length !== timeline.length)
      return "clearanceM length must match timeline length";
    for (let i = 0; i < result.clearanceM.length; i += 1)
      if (!Number.isFinite(result.clearanceM[i]!))
        return "clearanceM must be finite";
    // Ensure spanHashes present
    if (!result.spanHashes) return "spanHashes required";
    const hashes = normalizeSpanHashes(result.spanHashes);
    if (Object.keys(hashes).length === 0) return "spanHashes must not be empty";
    // Diagnostics must be array
    if (!Array.isArray(result.diagnostics)) return "diagnostics must be array";
    try {
      const compiled = compileCoasterFile(result.file);
      if (
        compiled.track.checksum.toLowerCase() !==
        result.track.checksum.toLowerCase()
      ) {
        return "file/track checksum mismatch";
      }
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
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
    (state.result ?? lastGoodResult)?.file.intent.elements.some(
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

      // Validate pinned selection still exists – authoritative intent, not design alias
      const selectedElementId = result.file.intent.elements.some(
        (element) => element.id === state.selectedElementId,
      )
        ? state.selectedElementId
        : null;

      // Deep-copy typed data ownership: clearanceM required
      const ownedClearance = new Float64Array(result.clearanceM);

      // Freeze owned result graph without mutating caller's object
      let ownedFile: CoasterFileV1;
      try {
        ownedFile = cloneFile(result.file);
      } catch (error) {
        failure(error, incomingRequestId ?? requestId);
        return false;
      }
      const ownedResult: AuthoritativeExperienceResult = Object.freeze({
        file: ownedFile,
        track: result.track,
        timeline: result.timeline, // RideTimeline/CompiledTrackData huge arrays are immutable/copying getters
        diagnostics: copyDiagnostics(result.diagnostics),
        ...(result.relaxations
          ? { relaxations: Object.freeze([...result.relaxations]) }
          : {}),
        spanHashes: Object.freeze({ ...nextHashes }),
        clearanceM: ownedClearance,
      });

      lastGoodResult = ownedResult;

      publish({
        ...state,
        status: "ready",
        result: ownedResult,
        lastGoodResult: ownedResult,
        error: null,
        pinnedElementIds: Object.freeze([...ownedFile.intent.pinnedElementIds]),
        draftFile: ownedFile,
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
      const baseFile = state.draftFile ?? base.file;
      const intentElement = baseFile.intent.elements.find(
        (e) => e.id === elementId,
      );
      if (!intentElement) return false;
      const newParameters: Record<string, string | number | boolean> = {
        ...(intentElement.parameters as Record<
          string,
          string | number | boolean
        >),
        [parameter]: value as string | number | boolean,
      };
      const newIntentElements = baseFile.intent.elements.map((e) =>
        e.id === elementId ? { ...e, parameters: newParameters } : e,
      );
      const newIntent = createDesignIntentV1({
        ...baseFile.intent,
        elements: newIntentElements,
      });
      try {
        const newFile = rebuildFileWithIntent(baseFile, newIntent);
        publish({ ...state, draftFile: newFile });
        return true;
      } catch {
        return false;
      }
    },
    togglePin: (elementId) => {
      if (!selectedElementExists(elementId)) return false;
      const base = state.result ?? lastGoodResult;
      if (!base) return false;
      const baseFile = state.draftFile ?? base.file;
      const pinned = state.pinnedElementIds.includes(elementId);
      const newPinned = pinned
        ? state.pinnedElementIds.filter((id) => id !== elementId)
        : [...state.pinnedElementIds, elementId];
      const newIntent = createDesignIntentV1({
        ...baseFile.intent,
        pinnedElementIds: [...newPinned],
      });
      try {
        const newFile = rebuildFileWithIntent(baseFile, newIntent);
        publish({
          ...state,
          pinnedElementIds: Object.freeze(newPinned),
          draftFile: newFile,
        });
        return !pinned;
      } catch {
        return false;
      }
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
        compileCoasterFile(payload);
      } catch (error) {
        failure(error, incomingRequestId);
      }
    },
  } as ExperienceController);
}
