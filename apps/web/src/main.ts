import "./styles.css";
import {
  createInitialState,
  getActionEnabled,
  getCanvasAriaLabel,
  getPanelVisibility,
  getReducedMotionState,
  getStatusText,
  selectCamera,
  selectMetric,
  type AppState,
  type CameraId,
  type MetricId,
} from "./viewState.js";
import { RenderMetrics } from "./render/metrics.js";
import { createAppLifecycle } from "./render/lifecycle.js";
import type { CompiledTrackData, Diagnostic } from "@openvibecoaster/core";
import { createDesignIntentV1 } from "@openvibecoaster/core";
import { EngineeringWorkerClient } from "./engineering/client.js";
import { createEngineeringWorkerFactory } from "./engineering/factory.js";
import { hydrateEngineeringSuccess } from "./engineering/hydrate.js";
import {
  createExperienceController,
  type AuthoritativeExperienceResult,
} from "./experienceController.js";
import {
  parseUint32Seed,
  validateDirectedInput,
  createDirectedDesignIntent,
  type DirectedEditorInput,
  type DirectedGateInput,
} from "./directedInput.js";
import { buildDirectedInputFromDom } from "./app/directed.js";
import {
  deriveMetricData,
  deriveSeatMetricData,
  getMetricSeries,
  getSeatCarIndex,
  getSeatMetricSeries,
} from "./app/metricData.js";
import { downloadCoasterFile } from "./app/download.js";
import { resolveZoneMask } from "./app/zone.js";
import { downgradeIfNoTrack } from "./app/downgrade.js";
import {
  getElementCompiledRange,
  getSemanticSeamIndices,
} from "./app/elementBounds.js";
import {
  preparePinnedRegeneration,
  restorePinnedFileAfterRegeneration,
} from "./app/pinnedRegeneration.js";
import { detectGateContradictions } from "./app/gateContradiction.js";
import {
  getSeamInspection,
  drawTimelineGraph,
  indexAtGraphPosition,
} from "./telemetry.js";
import { getCanvasKeyboardAction } from "./accessibility.js";
import { getTelemetryNextIndex } from "./app/telemetryKeyboard.js";
import { isShortcutOwnerElement } from "./app/shortcutTarget.js";
import {
  createRidePlayback,
  type RidePlaybackController,
  type RidePlaybackSnapshot,
  type RideSelectionId,
} from "./ride/controller.js";
import {
  getSeatOptionByValue,
  getSeatValueFromSnapshot,
  isAllowedRate,
  type AllowedRate,
} from "./app/playbackOptions.js";
import { createRideAudioEngine, type RideAudioEngine } from "./audio/engine.js";
import { computeTelemetrySignature } from "./app/telemetrySignature.js";

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element #${id}`);
  }
  return found as T;
}

const state: AppState = createInitialState();

// WebGL support is determined transactionally by THREE.WebGLRenderer creation via lifecycle.
// No preflight canvas.getContext("webgl") to avoid binding WebGL1 before Three.
let hasWebGL = true;
const prefersReducedMotionQuery = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
);
const prefersReducedMotion = prefersReducedMotionQuery.matches;
state.reducedMotion = getReducedMotionState(prefersReducedMotion, null);

// Elements
const body = document.body;
const topBarStatus = el<HTMLDivElement>("status");
const statusText = topBarStatus.querySelector(".status-text") as HTMLElement;
const viewportCanvas = el<HTMLCanvasElement>("viewport-canvas");
const viewportOverlay = el<HTMLDivElement>("viewport-overlay");
const overlayStatus = viewportOverlay.querySelector(
  ".overlay-status",
) as HTMLElement;
const webglFallback = el<HTMLDivElement>("webgl-fallback");
const generateBtn = el<HTMLButtonElement>("generate-btn");
const cancelGenerationBtn = el<HTMLButtonElement>("cancel-generation-btn");
const saveBtn = el<HTMLButtonElement>("save-btn");
const loadBtn = el<HTMLButtonElement>("load-btn");
const loadFile = el<HTMLInputElement>("load-file");
const exportBtn = el<HTMLButtonElement>("export-btn");
const muteBtn = el<HTMLButtonElement>("mute-btn");
const audioUnlockBtn = el<HTMLButtonElement>("audio-unlock-btn");
const seedInput = el<HTMLInputElement>("seed-input");
const modeInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="app-mode"]'),
);
const cameraInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="camera"]'),
);
const metricSelect = el<HTMLSelectElement>("metric-select");
const seatSelect = el<HTMLSelectElement>("seat-select");
const playbackSelect = el<HTMLSelectElement>("playback-speed");
const scrubber = el<HTMLInputElement>("scrubber");
const scrubberValue = document.querySelector(".scrubber-value") as HTMLElement;
const pauseBtn = el<HTMLButtonElement>("pause-btn");
const resetBtn = el<HTMLButtonElement>("reset-btn");
const seamInspectBtn = el<HTMLButtonElement>("seam-inspect-btn");
const localRegenerateBtn = el<HTMLButtonElement>("local-regenerate-btn");
const pinBtn = el<HTMLButtonElement>("pin-btn");
const inspectInputs = [
  el<HTMLInputElement>("inspect-length"),
  el<HTMLInputElement>("inspect-radius"),
  el<HTMLInputElement>("inspect-height"),
  el<HTMLInputElement>("inspect-roll"),
];
const telemetryEmpty = el<HTMLDivElement>("telemetry-empty");
const telemetryGraphWrap = document.querySelector(
  ".telemetry-graph-wrap",
) as HTMLElement;
const telemetryGraph = el<HTMLCanvasElement>("telemetry-graph");
telemetryGraph.tabIndex = 0;
telemetryGraph.setAttribute("role", "slider");
telemetryGraph.setAttribute("aria-valuemin", "0");
telemetryGraph.setAttribute("aria-valuemax", "0");
telemetryGraph.setAttribute("aria-valuenow", "0");
telemetryGraph.setAttribute("aria-orientation", "horizontal");
const webglRetry = el<HTMLButtonElement>("webgl-retry");

const generationRail = el<HTMLElement>("generation-rail");
const inspector = el<HTMLElement>("element-inspector");
const telemetry = el<HTMLElement>("telemetry");
const mobileTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".mobile-tab"),
);

// New DOM for directed and readouts
const generationModeInputs = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="generation-mode"]'),
);
const diagnosticsList = el<HTMLUListElement>("diagnostics-list");
const relaxationsList = el<HTMLUListElement>("relaxations-list");
const elementList = el<HTMLUListElement>("element-list");
const elementsEmptyHint = document.getElementById(
  "elements-empty-hint",
) as HTMLElement | null;
const selectionReadout = el<HTMLDivElement>("selection-readout");
const trackLengthEl = document.querySelector(
  '[data-testid="track-length"]',
) as HTMLElement;
const compiledChecksumEl = document.querySelector(
  '[data-testid="compiled-checksum"]',
) as HTMLElement;
const seamBoundariesEl = document.querySelector(
  '[data-testid="seam-boundaries"]',
) as HTMLElement;
const timelineDurationEl = document.querySelector(
  '[data-testid="timeline-duration"]',
) as HTMLElement;
const telemetrySignatureEl = document.querySelector(
  '[data-testid="telemetry-signature"]',
) as HTMLElement;
const trackHighlightEl = document.querySelector(
  '[data-testid="track-highlight"]',
) as HTMLElement;
const trainPositionEl = document.querySelector(
  '[data-testid="train-position"]',
) as HTMLElement;
const metricLegend = el<HTMLDivElement>("metric-legend");

function isDiagnostic(value: unknown): value is Diagnostic {
  if (typeof value !== "object" || value === null) return false;
  if (!("code" in value) || typeof Reflect.get(value, "code") !== "string")
    return false;
  if (!("severity" in value)) return false;
  const severity = Reflect.get(value, "severity");
  if (
    severity !== "info" &&
    severity !== "warning" &&
    severity !== "error" &&
    severity !== "fatal"
  )
    return false;
  if (
    !("message" in value) ||
    typeof Reflect.get(value, "message") !== "string"
  )
    return false;
  if ("provenance" in value) {
    const provenance = Reflect.get(value, "provenance");
    if (
      provenance !== undefined &&
      provenance !== "SOURCE_VERIFIED" &&
      provenance !== "PROJECT_ENGINEERING_LIMIT" &&
      provenance !== "DESIGN_ASSUMPTION" &&
      provenance !== "UNKNOWN_UNCONFIGURED"
    )
      return false;
  }
  return true;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function normalizeEngineeringError(e: unknown): {
  message: string;
  code?: string;
  diagnostics?: Diagnostic[];
  relaxations?: string[];
} {
  if (typeof e === "object" && e !== null && "message" in e) {
    const messageValue = Reflect.get(e, "message");
    const message = typeof messageValue === "string" ? messageValue : String(e);
    const codeValue = Reflect.get(e, "code");
    const code = typeof codeValue === "string" ? codeValue : undefined;
    const diagnosticsValue = Reflect.get(e, "diagnostics");
    const diagnostics =
      Array.isArray(diagnosticsValue) && diagnosticsValue.every(isDiagnostic)
        ? diagnosticsValue.filter(isDiagnostic)
        : undefined;
    const relaxationsValue = Reflect.get(e, "relaxations");
    const relaxations = isStringArray(relaxationsValue)
      ? relaxationsValue.filter((v) => typeof v === "string")
      : undefined;
    return {
      message,
      ...(code !== undefined ? { code } : {}),
      ...(diagnostics !== undefined ? { diagnostics } : {}),
      ...(relaxations !== undefined ? { relaxations } : {}),
    };
  }
  return { message: String(e) };
}

function getAuthoritativeResult(): AuthoritativeExperienceResult | null {
  return controller.getState().result ?? controller.getState().lastGoodResult;
}

function getSelectedElementId(): string | null {
  return controller.getState().selectedElementId;
}

function getSpanHash(
  spanHashes:
    | Readonly<Record<string, string>>
    | readonly { readonly spanId: string; readonly hash: string }[],
  id: string,
): string | undefined {
  if (Array.isArray(spanHashes)) {
    const found = spanHashes.find((e) => e.spanId === id);
    return found?.hash;
  }
  if (
    typeof spanHashes === "object" &&
    spanHashes !== null &&
    id in spanHashes
  ) {
    const val = Reflect.get(spanHashes, id);
    return typeof val === "string" ? val : undefined;
  }
  return undefined;
}

function getSelectedTimelineIndex(): number | null {
  return controller.getState().timelineSelection?.index ?? null;
}

function syncBodyClasses(): void {
  body.classList.toggle("mode-ride", state.appMode === "ride");
  body.classList.toggle("mode-edit", state.appMode === "edit");
  body.classList.toggle("reduced-motion", state.reducedMotion);
  body.classList.toggle("no-webgl", !hasWebGL);
  body.dataset.status = state.generationStatus;
}

let visibleErrorMessage: string | null = null;

function render(): void {
  syncBodyClasses();
  const text = getStatusText(state.generationStatus, visibleErrorMessage);
  statusText.textContent = text;
  topBarStatus.dataset.state = state.generationStatus;
  overlayStatus.textContent =
    state.generationStatus === "pending"
      ? "Generation pending"
      : state.generationStatus === "generating"
        ? "Generating…"
        : state.generationStatus === "ready"
          ? "Ready — viewport idle"
          : "Generation failed";
  const overlayShouldHide = state.generationStatus === "ready";
  viewportOverlay.hidden = overlayShouldHide;
  viewportOverlay.setAttribute(
    "aria-hidden",
    overlayShouldHide ? "true" : "false",
  );
  if (elementsEmptyHint) {
    const shouldHideElementsHint = state.generationStatus === "ready";
    elementsEmptyHint.hidden = shouldHideElementsHint;
    elementsEmptyHint.setAttribute(
      "aria-hidden",
      shouldHideElementsHint ? "true" : "false",
    );
  }
  viewportCanvas.setAttribute(
    "aria-label",
    getCanvasAriaLabel(state.generationStatus),
  );

  const canSave = getActionEnabled("save", state.generationStatus);
  const canExport = getActionEnabled("export", state.generationStatus);
  const canScrub = getActionEnabled("scrub", state.generationStatus);
  const canPlayback = getActionEnabled("playback", state.generationStatus);
  const canSeam = getActionEnabled("seamInspect", state.generationStatus);
  const canLocal = getActionEnabled("localRegenerate", state.generationStatus);
  const canGenerate = getActionEnabled("generate", state.generationStatus);

  saveBtn.disabled = !canSave;
  exportBtn.disabled = !canExport;
  scrubber.disabled = !canScrub;
  pauseBtn.disabled = !canPlayback;
  resetBtn.disabled = !canPlayback;
  playbackSelect.disabled = !canPlayback || !hasWebGL;
  seamInspectBtn.disabled = !canSeam;
  localRegenerateBtn.disabled = !canLocal;
  metricSelect.disabled = !canPlayback || !hasWebGL;
  seatSelect.disabled = !canPlayback || !hasWebGL;
  generateBtn.disabled = !canGenerate;
  generateBtn.textContent =
    state.generationStatus === "generating" ? "Generating…" : "Insta Generate";
  cancelGenerationBtn.disabled = state.generationStatus !== "generating";

  for (const input of inspectInputs) {
    input.disabled = !canLocal;
  }

  for (const input of cameraInputs) {
    input.disabled = !hasWebGL;
  }

  const vis = getPanelVisibility(state);
  generationRail.hidden = !vis.leftRailVisible;
  inspector.hidden = !vis.rightInspectorVisible;
  telemetry.hidden = !vis.telemetryVisible && state.appMode !== "ride";
  if (state.appMode === "ride") {
    generationRail.setAttribute("aria-hidden", "true");
    inspector.setAttribute("aria-hidden", "true");
  } else {
    generationRail.removeAttribute("aria-hidden");
    inspector.removeAttribute("aria-hidden");
  }

  pauseBtn.setAttribute("aria-pressed", String(!state.isPaused));
  pauseBtn.textContent = state.isPaused ? "Play" : "Pause";
  muteBtn.setAttribute("aria-pressed", String(state.isMuted));
  muteBtn.textContent = state.isMuted ? "Unmute" : "Mute";
  pinBtn.setAttribute("aria-pressed", String(pinBtn.dataset.pinned === "true"));

  for (const input of modeInputs) {
    input.checked = input.value === state.appMode;
  }
  for (const input of cameraInputs) {
    input.checked = input.value === state.camera;
  }
  metricSelect.value = state.metric;
  // Map legacy numeric seatIndex to seatId for production observability
  {
    const snapForSeat = ridePlayback?.getSnapshot() ?? null;
    if (snapForSeat) {
      seatSelect.value = getSeatValueFromSnapshot(snapForSeat);
    } else {
      const seatIdFromIndex =
        state.seatIndex === 0
          ? "front"
          : state.seatIndex === 3
            ? "rear"
            : "middle";
      const opt = getSeatOptionByValue(seatIdFromIndex);
      seatSelect.value = opt?.value ?? "front";
    }
  }
  playbackSelect.value = String(state.playbackSpeed);
  scrubberValue.textContent = `${scrubber.value} / ${scrubber.max}`;

  const hasData = state.generationStatus === "ready";
  telemetryGraphWrap.classList.toggle("has-data", hasData);
  telemetryEmpty.hidden = hasData;
  telemetryGraph.setAttribute(
    "aria-label",
    hasData
      ? `Telemetry graph — ${state.metric} at seat ${state.seatIndex + 1}`
      : "Telemetry graph — no data, generate to populate",
  );

  if (!hasWebGL) {
    webglFallback.hidden = false;
    viewportCanvas.hidden = true;
  } else {
    webglFallback.hidden = true;
    viewportCanvas.hidden = false;
  }

  if (document.activeElement !== seedInput) {
    seedInput.value = state.seed;
  }
}

// Lifecycle setup
const metrics = new RenderMetrics();
let lastSetupError: unknown = null;
let lastRuntimeError: unknown = null;
function handleVisibleUnexpectedError(error: unknown): void {
  lastSetupError = error;
  lastRuntimeError = error;
  visibleErrorMessage = error instanceof Error ? error.message : String(error);
  hasWebGL = true;
  state.generationStatus = "error";
  render();
}
const lifecycle = createAppLifecycle({
  canvas: viewportCanvas,
  getTerrainSeed: () => state.seed || "default-terrain",
  getTerrainProfileId: () => "rolling-highlands-v1",
  getDprCap: () => 2,
  metrics,
  getCameraId: () => state.camera,
  getReducedMotion: () => state.reducedMotion,
  getSnapshot: () => ridePlayback?.getSnapshot() ?? null,
  onResize2D: () => resizeCanvases(),
  onWebGLFailure: () => {
    hasWebGL = false;
    render();
  },
  onSetupError: (e) => {
    handleVisibleUnexpectedError(e);
  },
  onRuntimeError: (e) => {
    handleVisibleUnexpectedError(e);
  },
  onFrame: (deltaSeconds: number) => {
    if (ridePlayback) {
      try {
        ridePlayback.tick(deltaSeconds);
      } catch {}
    }
    if (ridePlayback) {
      const snap = ridePlayback.getSnapshot();
      const track = lifecycle.getController()?.getTrackData() ?? null;
      const zoneMask = track ? resolveZoneMask(track, snap.headDistanceM) : 0;
      if (audioEngine) {
        try {
          audioEngine.update({
            speedMps: snap.speedMps,
            zoneMask,
            paused: !snap.isPlaying,
          });
        } catch {}
      }
      lifecycle.updatePlayback(snap.headDistanceM, snap.speedMps, snap);
    }
  },
});

function truthfulDowngrade(): void {
  state.generationStatus = downgradeIfNoTrack(
    state.generationStatus,
    lifecycle.hasTrack(),
  );
}
function syncReadyDowngrade(ok: boolean): void {
  if (!ok) truthfulDowngrade();
}
function initRenderer(): void {
  lastSetupError = null;
  lastRuntimeError = null;
  const ok = lifecycle.init();
  if (ok) {
    hasWebGL = true;
  } else {
    if (lastSetupError === null && lastRuntimeError === null) {
      hasWebGL = false;
    }
  }
  syncReadyDowngrade(ok);
  render();
}
initRenderer();
webglRetry.addEventListener("click", () => {
  lastSetupError = null;
  lastRuntimeError = null;
  const ok = lifecycle.reinitialize();
  if (ok) {
    hasWebGL = true;
  } else if (lastSetupError === null && lastRuntimeError === null) {
    hasWebGL = false;
  }
  syncReadyDowngrade(ok);
  render();
  if (!ok) {
    const p = webglFallback.querySelector("p");
    if (p) {
      p.textContent =
        "Still unavailable — try restarting the browser with hardware acceleration enabled.";
    }
  }
});

function resizeCanvases(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = telemetryGraph.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (telemetryGraph.width !== w || telemetryGraph.height !== h) {
    telemetryGraph.width = w;
    telemetryGraph.height = h;
  }
  // telemetry drawing is handled via subscription; just clear if not ready
  if (state.generationStatus !== "ready") {
    const ctx = telemetryGraph.getContext("2d");
    if (ctx) {
      ctx.clearRect(0, 0, w, h);
    }
  }
}

// Worker and controller wiring — exactly one each
const engineeringClient = new EngineeringWorkerClient(
  createEngineeringWorkerFactory(),
);

let activeWorkerRequestId: string | null = null;
let generationStartMark: number | null = null;
let pendingObjectUrls: string[] = [];
let pendingRevokeTimers: number[] = [];
const abortController = new AbortController();
const abortSignal = abortController.signal;
let ridePlayback: RidePlaybackController | null = null;
let unsubscribeRidePlayback: (() => void) | null = null;
let audioEngine: RideAudioEngine | null = null;
let lastFailureDiagnostics: readonly Diagnostic[] = [];
let lastFailureRelaxations: readonly string[] = [];

function workerRequestIdFromNumeric(numeric: number): string {
  return `req-${numeric.toString(16).padStart(8, "0")}`;
}

function getGenerationMode(): string {
  const checked = generationModeInputs.find((i) => i.checked);
  return checked?.value ?? "insta";
}

function buildInstaIntent(
  seed: number,
  mode: "insta" | "full-auto",
): ReturnType<typeof createDesignIntentV1> {
  return createDesignIntentV1({
    generatorVersion: "generator-v1",
    seed,
    mode,
    family: "steel-sitdown-lsm-v1",
    elements: [],
    gates: [],
    targets: [],
    constraints: [],
    terrainProfileId: "rolling-highlands-v1",
    pinnedElementIds: [],
  });
}

function readDirectedControls(): {
  intent: import("@openvibecoaster/core").DesignIntentV1 | null;
  errors: readonly import("./directedInput.js").FieldError[];
  editorInput: DirectedEditorInput | null;
} {
  const { editorInput: builtInput, parsedSeed } = buildDirectedInputFromDom(
    seedInput.value,
    controller.getState().pinnedElementIds,
  );
  const errors = validateDirectedInput(builtInput);
  if (errors.length > 0) {
    return { intent: null, errors, editorInput: builtInput };
  }
  if (parsedSeed === null) {
    return {
      intent: null,
      errors: [{ field: "seed", message: "expected uint32 integer" }],
      editorInput: builtInput,
    };
  }
  const { intent, errors: createErrors } =
    createDirectedDesignIntent(builtInput);
  return { intent, errors: createErrors, editorInput: builtInput };
}

// DOM population helpers
function renderDiagnostics(diagnostics: readonly Diagnostic[]): void {
  diagnosticsList.innerHTML = "";
  for (const d of diagnostics) {
    const li = document.createElement("li");
    li.dataset.severity = d.severity;
    li.dataset.code = d.code;
    li.dataset.provenance = d.provenance ?? "";
    if (d.location?.s !== undefined && Number.isFinite(d.location.s)) {
      li.dataset.locationS = String(d.location.s);
    }
    if (d.margin !== undefined && Number.isFinite(d.margin)) {
      li.dataset.margin = String(d.margin);
    }
    if (d.actual !== undefined && Number.isFinite(d.actual)) {
      li.dataset.actual = String(d.actual);
    }
    if (d.limit !== undefined && Number.isFinite(d.limit)) {
      li.dataset.limit = String(d.limit);
    }
    li.textContent = `${d.code}: ${d.message}`;
    diagnosticsList.appendChild(li);
  }
}
function renderRelaxations(relaxations: readonly string[]): void {
  relaxationsList.innerHTML = "";
  for (const r of relaxations) {
    const li = document.createElement("li");
    // Ensure label tested/suggested
    const hasTested = /tested/i.test(r);
    const hasSuggested = /suggested/i.test(r);
    if (!hasTested && !hasSuggested) {
      li.dataset.tested = "true";
      li.textContent = `tested: ${r}`;
    } else {
      li.textContent = r;
      if (hasTested) li.dataset.tested = "true";
      if (hasSuggested) li.dataset.suggested = "true";
    }
    // Never claim applied
    relaxationsList.appendChild(li);
  }
}
function activateElementSelection(
  elementId: string,
  file: import("@openvibecoaster/core").CoasterFileV1,
  track: CompiledTrackData,
): void {
  controller.selectElement(elementId);
  const elementIndex = file.intent.elements.findIndex(
    (e) => e.id === elementId,
  );
  if (elementIndex >= 0) {
    lifecycle.updateSelection({ selectedElementIndex: elementIndex });
    const params2 = file.intent.elements[elementIndex]!.parameters;
    const lenVal = params2?.["length"] ?? params2?.["height"] ?? "";
    const lenEl = document.getElementById(
      "inspect-length",
    ) as HTMLInputElement | null;
    if (lenEl) lenEl.value = String(lenVal);
    const range = getElementCompiledRange(elementId, file, track);
    const distance = range ? (track.distances[range.start] ?? 0) : 0;
    selectionReadout.textContent = `Selected ${elementId} at ${distance.toFixed(1)} m`;
  }
}

function renderElementList(
  track: CompiledTrackData,
  spanHashes:
    | Readonly<Record<string, string>>
    | readonly { readonly spanId: string; readonly hash: string }[],
  file: import("@openvibecoaster/core").CoasterFileV1,
): void {
  elementList.innerHTML = "";
  for (const el of file.intent.elements) {
    const li = document.createElement("li");
    li.dataset.elementId = el.id;
    const hash = getSpanHash(spanHashes, el.id);
    if (hash) {
      li.dataset.spanHash = hash.toLowerCase().slice(0, 8);
    }
    const kind = el.kind ?? el.type ?? "element";
    const params = el.parameters;
    let text = `${kind} — ${el.id}`;
    if (kind === "topHat" || kind === "top-hat") {
      const heightVal = params?.["height"];
      const heightPart = typeof heightVal === "number" ? `${heightVal}m` : "";
      const bankVal = params?.["bank"];
      const bankPart = typeof bankVal === "number" ? `bank ${bankVal}` : "";
      const range = getElementCompiledRange(el.id, file, track);
      let inverted = "";
      if (range) {
        const { start, end } = range;
        const banks = track.bank;
        let minBank = Infinity;
        let maxBank = -Infinity;
        for (let i = start; i <= end; i++) {
          const b = banks[i];
          if (typeof b === "number" && Number.isFinite(b)) {
            minBank = Math.min(minBank, b);
            maxBank = Math.max(maxBank, b);
          }
        }
        if (
          Number.isFinite(minBank) &&
          Number.isFinite(maxBank) &&
          Math.abs(maxBank - minBank) > Math.PI * 0.8
        ) {
          inverted = "inverted";
        }
      }
      const parts = ["topHat", heightPart, inverted, bankPart, `— ${el.id}`]
        .filter(Boolean)
        .join(" ");
      text = parts;
    } else if (kind === "stall") {
      text = `stall — ${el.id}`;
    } else {
      text = `${kind} — ${el.id}`;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "element-select-btn";
    btn.textContent = text;
    btn.setAttribute("aria-label", `Select element ${el.id}`);
    const activate = (): void => activateElementSelection(el.id, file, track);
    btn.addEventListener("click", activate);
    li.appendChild(btn);
    elementList.appendChild(li);
  }
}

function updateReadoutsForResult(result: AuthoritativeExperienceResult): void {
  const track = result.track;
  const timeline = result.timeline;
  // Length
  if (trackLengthEl) {
    trackLengthEl.textContent = `${track.totalLength.toFixed(1)} m`;
    trackLengthEl.setAttribute("data-length-m", String(track.totalLength));
  }
  if (compiledChecksumEl) {
    compiledChecksumEl.textContent = track.checksum;
    compiledChecksumEl.setAttribute(
      "data-checksum",
      track.checksum.toLowerCase(),
    );
    compiledChecksumEl.setAttribute(
      "data-compiled-checksum",
      track.checksum.toLowerCase(),
    );
  }
  if (seamBoundariesEl) {
    const semanticSeams = getSemanticSeamIndices(result.file, track);
    const total = semanticSeams.length;
    seamBoundariesEl.textContent = `Seams ${total}`;
    const isInspecting = controller.getState().seamInspection;
    const displayed = isInspecting ? total : 0;
    seamBoundariesEl.setAttribute("data-count", String(displayed));
  }
  if (timelineDurationEl) {
    const duration = timeline.timeSeconds[timeline.length - 1] ?? 0;
    timelineDurationEl.textContent = `${duration.toFixed(2)} s`;
    timelineDurationEl.setAttribute("data-duration-s", String(duration));
  }
  if (telemetrySignatureEl) {
    const sig = computeTelemetrySignature(track, timeline);
    telemetrySignatureEl.textContent = sig;
    telemetrySignatureEl.setAttribute("data-signature", sig);
  }
  // Initialize highlight/train position to first sample
  if (trackHighlightEl) {
    const d0 = timeline.headDistanceM[0] ?? 0;
    trackHighlightEl.setAttribute("data-highlight-distance", String(d0));
    trackHighlightEl.textContent = `Highlight ${d0.toFixed(1)} m`;
  }
  if (trainPositionEl) {
    const d0 = timeline.headDistanceM[0] ?? 0;
    const s0 = timeline.speedMps[0] ?? 0;
    trainPositionEl.setAttribute("data-distance-m", String(d0));
    trainPositionEl.setAttribute("data-speed-mps", String(s0));
    trainPositionEl.textContent = `Train ${d0.toFixed(1)} m at ${s0.toFixed(1)} m/s`;
  }
}

function updatePlaybackDomFromSnapshot(
  snap: ReturnType<RidePlaybackController["getSnapshot"]>,
): void {
  const d = snap.headDistanceM;
  const s = snap.speedMps;
  if (trackHighlightEl) {
    trackHighlightEl.setAttribute("data-highlight-distance", String(d));
    trackHighlightEl.textContent = `Highlight ${d.toFixed(1)} m`;
  }
  if (trainPositionEl) {
    trainPositionEl.setAttribute("data-distance-m", String(d));
    trainPositionEl.setAttribute("data-speed-mps", String(s));
    trainPositionEl.textContent = `Train ${d.toFixed(1)} m at ${s.toFixed(1)} m/s`;
  }
  // Scrubber sync
  const authForSync = getAuthoritativeResult();
  const syncTimeline = authForSync?.timeline ?? null;
  if (syncTimeline) {
    const maxIdx = syncTimeline.length - 1;
    const ratio = maxIdx > 0 ? snap.sampleIndex / maxIdx : 0;
    const scrubVal = Math.round(ratio * 1000);
    scrubber.value = String(scrubVal);
    scrubberValue.textContent = `${scrubVal} / ${scrubber.max}`;
  }
  // Selection readout sync with distance/time
  if (syncTimeline) {
    const time = snap.timeSeconds;
    selectionReadout.textContent = `Distance ${d.toFixed(1)} m — time ${time.toFixed(2)} s at ${s.toFixed(1)} m/s`;
  }
}

function updateSeatTelemetryFromSnapshot(snap: RidePlaybackSnapshot): void {
  const el = document.getElementById("seat-telemetry") as HTMLElement | null;
  if (!el) return;
  const carCount = snap.carCount;
  const seatId = snap.selectedSeat;
  const carIndex = getSeatCarIndex(seatId, carCount);
  const selections = snap.selections;
  const selection =
    seatId === "front"
      ? selections.front
      : seatId === "rear"
        ? selections.rear
        : selections.middle;
  const car = selection.car ?? snap.cars[carIndex];
  const perCarTelemetry = car?.telemetry;
  const verticalG = perCarTelemetry?.verticalG;
  const lateralG = perCarTelemetry?.lateralG;
  const longitudinalG = perCarTelemetry?.longitudinalG;
  const jerkVec = perCarTelemetry?.jerkMps3;
  const rollRate = perCarTelemetry?.rollRateRadPerSec;
  const bank = perCarTelemetry?.bankRad;
  const heightY = car?.position?.[1] ?? selection.position?.[1] ?? 0;
  const label = seatId.charAt(0).toUpperCase() + seatId.slice(1);
  const carNumber = carIndex + 1;
  const speedTrainWide = snap.speedMps;
  const energyTrainWide = snap.telemetry?.energyErrorJ ?? 0;
  const launchTrainWide = snap.telemetry?.launchActivity ? "active" : "idle";
  const brakeTrainWide = snap.telemetry?.brakeActivity ? "active" : "idle";
  const hasPerCar = perCarTelemetry !== undefined;
  el.setAttribute("data-car-index", String(carIndex));
  el.setAttribute("data-car-count", String(carCount));
  el.setAttribute(
    "data-vertical-g",
    hasPerCar && verticalG !== undefined ? String(verticalG) : "unavailable",
  );
  el.setAttribute(
    "data-lateral-g",
    hasPerCar && lateralG !== undefined ? String(lateralG) : "unavailable",
  );
  el.setAttribute(
    "data-longitudinal-g",
    hasPerCar && longitudinalG !== undefined
      ? String(longitudinalG)
      : "unavailable",
  );
  if (hasPerCar && jerkVec) {
    const jerkMag = Math.hypot(
      jerkVec[0] ?? 0,
      jerkVec[1] ?? 0,
      jerkVec[2] ?? 0,
    );
    el.setAttribute("data-jerk", String(jerkMag));
    el.setAttribute("data-jerk-x", String(jerkVec[0] ?? 0));
    el.setAttribute("data-jerk-y", String(jerkVec[1] ?? 0));
    el.setAttribute("data-jerk-z", String(jerkVec[2] ?? 0));
  } else {
    el.setAttribute("data-jerk", "unavailable");
    el.setAttribute("data-jerk-x", "unavailable");
    el.setAttribute("data-jerk-y", "unavailable");
    el.setAttribute("data-jerk-z", "unavailable");
  }
  el.setAttribute(
    "data-roll-rate",
    hasPerCar && rollRate !== undefined ? String(rollRate) : "unavailable",
  );
  el.setAttribute(
    "data-bank",
    hasPerCar && bank !== undefined ? String(bank) : "unavailable",
  );
  el.setAttribute("data-height", String(heightY));
  if (!hasPerCar) {
    el.textContent = `Seat ${label} — car ${carNumber}/${carCount} — per-car telemetry unavailable — train-wide: speed ${speedTrainWide.toFixed(1)} m/s, energy ${energyTrainWide.toFixed(1)} J, LSM ${launchTrainWide}, brake ${brakeTrainWide}, clearance train-wide`;
    return;
  }
  const jerkMag2 = Math.hypot(
    jerkVec![0] ?? 0,
    jerkVec![1] ?? 0,
    jerkVec![2] ?? 0,
  );
  el.textContent = `Seat ${label} — car ${carNumber}/${carCount} — vertical ${verticalG!.toFixed(2)} g, lateral ${lateralG!.toFixed(2)} g, longitudinal ${longitudinalG!.toFixed(2)} g, jerk ${jerkMag2.toFixed(2)} m/s³ (x ${(jerkVec![0] ?? 0).toFixed(2)} y ${(jerkVec![1] ?? 0).toFixed(2)} z ${(jerkVec![2] ?? 0).toFixed(2)}), roll ${rollRate!.toFixed(3)} rad/s, bank ${((bank! * 180) / Math.PI).toFixed(1)}° (${bank!.toFixed(3)} rad), height ${heightY.toFixed(1)} m — train-wide: speed ${speedTrainWide.toFixed(1)} m/s, energy ${energyTrainWide.toFixed(1)} J, LSM ${launchTrainWide}, brake ${brakeTrainWide}, clearance train-wide`;
}

function isSeatMetric(metric: MetricId): boolean {
  return metric === "gForce" || metric === "rollRate";
}

function getCurrentSeatId(): RideSelectionId {
  return ridePlayback?.getSnapshot().selectedSeat ?? "front";
}

function updateMetricForSeat(snap: RidePlaybackSnapshot): void {
  const auth = getAuthoritativeResult();
  if (!auth) return;
  const seatId = snap.selectedSeat;
  if (isSeatMetric(state.metric)) {
    const metricData = deriveSeatMetricData(state.metric, auth, seatId);
    if (metricData) {
      lifecycle.setMetric(state.metric, metricData);
      const series = getSeatMetricSeries(state.metric, auth, seatId);
      drawTimelineGraph(telemetryGraph, series, snap.sampleIndex);
      return;
    }
    // unavailable per-car: show unavailable series and clear rail colors?
    const series = getSeatMetricSeries(state.metric, auth, seatId);
    drawTimelineGraph(telemetryGraph, series, snap.sampleIndex);
    // do not fabricate head series
    lifecycle.setMetric(state.metric, undefined);
    return;
  }
  // train-wide metrics
  const series = getMetricSeries(
    state.metric,
    auth.track,
    auth.timeline,
    auth.clearanceM ?? null,
  );
  drawTimelineGraph(telemetryGraph, series, snap.sampleIndex);
}

function updateAudioStatus(): void {
  const el = document.getElementById("audio-status") as HTMLElement | null;
  if (!el) return;
  const stateAudio = audioEngine?.getState() ?? null;
  const status = stateAudio?.status ?? "locked";
  const muted = stateAudio?.muted ?? state.isMuted;
  let effectiveGain = 0;
  let audible = false;
  if (stateAudio) {
    const layers = stateAudio.layers;
    const sum =
      (layers.wind.gain ?? 0) +
      (layers.rail.gain ?? 0) +
      (layers.lsm.gain ?? 0) +
      (layers.brake.gain ?? 0);
    effectiveGain = muted ? 0 : sum;
    audible = effectiveGain > 1e-6 && status === "ready" && !muted;
    if (status === "unsupported" || status === "failed") {
      effectiveGain = 0;
      audible = false;
    }
  }
  el.setAttribute("data-status", status);
  el.setAttribute("data-muted", String(muted));
  el.setAttribute("data-effective-gain", String(effectiveGain));
  el.setAttribute("data-audible", String(audible));
  el.textContent = `Audio ${status} — muted ${muted} — gain ${effectiveGain.toFixed(3)} — audible ${audible}`;
}

function syncPlaybackControlsFromSnapshot(snap: RidePlaybackSnapshot): void {
  state.isPaused = !snap.isPlaying;
  state.playbackSpeed = snap.rate;
  const seatValue = getSeatValueFromSnapshot(snap);
  // keep numeric seatIndex for legacy graph label, map seatId to 0/1/2
  state.seatIndex = seatValue === "front" ? 0 : seatValue === "rear" ? 2 : 1;
  pauseBtn.setAttribute("aria-pressed", String(!state.isPaused));
  pauseBtn.textContent = state.isPaused ? "Play" : "Pause";
  playbackSelect.value = String(snap.rate);
  seatSelect.value = seatValue;
  updatePlaybackDomFromSnapshot(snap);
  updateSeatTelemetryFromSnapshot(snap);
  updateMetricForSeat(snap);
  updateAudioStatus();
  syncTelemetryGraphA11y();
}

function renderMetricLegend(metric: MetricId): void {
  for (const item of metricLegend.querySelectorAll<HTMLElement>(
    "[data-metric]",
  )) {
    const m = item.dataset.metric ?? "";
    const selected = m === metric;
    item.classList.toggle("is-selected", selected);
    item.setAttribute("aria-selected", String(selected));
    item.setAttribute("data-selected", String(selected));
  }
}

let unsubscribeController: (() => void) | null = null;

// ExperienceController with real callbacks
const controller = createExperienceController({
  onGenerate: async (request, numericId) => {
    const workerId = workerRequestIdFromNumeric(numericId);
    if (activeWorkerRequestId && activeWorkerRequestId !== workerId) {
      engineeringClient.cancel(activeWorkerRequestId);
    }
    activeWorkerRequestId = workerId;
    generationStartMark = performance.now();
    try {
      performance.mark("ovc:generation-total-start");
    } catch {}
    try {
      let intent: import("@openvibecoaster/core").DesignIntentV1;
      if (request.mode === "insta" || request.mode === "full-auto") {
        const seed = request.seed;
        if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
          throw new Error("seed: expected uint32 integer");
        }
        intent = buildInstaIntent(seed, request.mode);
      } else {
        const validation = validateDirectedInput(request.input);
        if (validation.length > 0) {
          const msgs = validation
            .map((e) => `${e.field}: ${e.message}`)
            .join("; ");
          lastFailureDiagnostics = validation.map((e) => ({
            code: "INVALID_INTENT",
            severity: "error" as const,
            provenance: "PROJECT_ENGINEERING_LIMIT" as const,
            message: `${e.field}: ${e.message}`,
          }));
          lastFailureRelaxations = [];
          renderDiagnostics(lastFailureDiagnostics);
          renderRelaxations([]);
          throw new Error(msgs || "Invalid directed input");
        }
        const { intent: directedIntent, errors } = createDirectedDesignIntent(
          request.input,
        );
        if (!directedIntent) {
          const msgs = errors.map((e) => `${e.field}: ${e.message}`).join("; ");
          lastFailureDiagnostics = errors.map((e) => ({
            code: "INVALID_INTENT",
            severity: "error" as const,
            provenance: "PROJECT_ENGINEERING_LIMIT" as const,
            message: `${e.field}: ${e.message}`,
          }));
          lastFailureRelaxations = [];
          renderDiagnostics(lastFailureDiagnostics);
          renderRelaxations([]);
          throw new Error(msgs || "Invalid directed input");
        }
        const gateDiags = detectGateContradictions(request.input);
        if (gateDiags.length > 0) {
          lastFailureDiagnostics = gateDiags;
          renderDiagnostics(gateDiags);
          lastFailureRelaxations = [];
          renderRelaxations([]);
          throw new Error(gateDiags[0]!.message);
        }
        intent = directedIntent;
      }
      // Await worker
      const response = await engineeringClient.generate(workerId, intent);
      // Stale check already via controller, but also check activeWorkerRequestId
      const hydrated = hydrateEngineeringSuccess(response);
      const result: AuthoritativeExperienceResult = {
        file: hydrated.file,
        track: hydrated.track,
        timeline: hydrated.timeline,
        diagnostics: hydrated.diagnostics,
        relaxations: hydrated.relaxations,
        spanHashes: hydrated.spanHashes,
      };
      controller.setResult(result, numericId);
      // Clear failure caches on success
      lastFailureDiagnostics = [];
      lastFailureRelaxations = [];
    } catch (e) {
      const err = normalizeEngineeringError(e);
      // Handle cancelled gracefully - don't surface as error if stale
      if (err.code === "cancelled") {
        controller.setError("Cancelled", numericId);
        return;
      }
      // Extract diagnostics if present (worker failure)
      if (err.diagnostics) {
        lastFailureDiagnostics = err.diagnostics;
        // Ensure at least one has provenance and finite evidence where applicable
        renderDiagnostics(lastFailureDiagnostics);
      } else if (lastFailureDiagnostics.length === 0) {
        const msg = err.message;
        lastFailureDiagnostics = [
          {
            code: "GENERATION_ERROR",
            severity: "error",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: msg,
          },
        ];
        renderDiagnostics(lastFailureDiagnostics);
      }
      if (err.relaxations) {
        lastFailureRelaxations = err.relaxations;
        renderRelaxations(lastFailureRelaxations);
      } else {
        // keep existing relaxations if any
        renderRelaxations(lastFailureRelaxations);
      }
      const message = err.message;
      // Set controller error matching request
      controller.setError(message, numericId);
    } finally {
      if (activeWorkerRequestId === workerId) activeWorkerRequestId = null;
    }
  },
  onLocalRegenerate: async (req, numericId) => {
    const workerId = workerRequestIdFromNumeric(numericId);
    if (activeWorkerRequestId && activeWorkerRequestId !== workerId) {
      engineeringClient.cancel(activeWorkerRequestId);
    }
    activeWorkerRequestId = workerId;
    try {
      const preparation = preparePinnedRegeneration(req);
      if (preparation.kind === "fatal") {
        lastFailureDiagnostics = [preparation.diagnostic];
        renderDiagnostics(lastFailureDiagnostics);
        lastFailureRelaxations = [];
        renderRelaxations([]);
        controller.setError(preparation.diagnostic.message, numericId);
        // Also ensure the diagnostic is stored for seam filtering
        return;
      }
      const targetId = preparation.targetId;
      const workerFile = preparation.workerFile;
      const restoreId = preparation.restoreId;
      const originalPinnedIds = preparation.originalPinnedIds;
      const response = await engineeringClient.regenerate(
        workerId,
        workerFile,
        targetId,
      );
      const hydrated = hydrateEngineeringSuccess(response);
      let resultFile: typeof hydrated.file = hydrated.file;
      if (restoreId) {
        resultFile = restorePinnedFileAfterRegeneration(
          hydrated.file,
          restoreId,
          originalPinnedIds,
        );
      }
      const result: AuthoritativeExperienceResult = {
        file: resultFile,
        track: hydrated.track,
        timeline: hydrated.timeline,
        diagnostics: hydrated.diagnostics,
        relaxations: hydrated.relaxations,
        spanHashes: hydrated.spanHashes,
      };
      const ok = controller.setResult(result, numericId);
      if (ok) {
        // keep selection/pin visible: controller will preserve selectedElementId if still exists
      }
    } catch (e) {
      const err = normalizeEngineeringError(e);
      if (err.code === "cancelled") {
        controller.setError("Cancelled", numericId);
        return;
      }
      if (err.diagnostics) {
        lastFailureDiagnostics = err.diagnostics;
        renderDiagnostics(lastFailureDiagnostics);
      }
      if (err.relaxations) {
        lastFailureRelaxations = err.relaxations;
        renderRelaxations(lastFailureRelaxations);
      }
      controller.setError(err.message, numericId);
    } finally {
      if (activeWorkerRequestId === workerId) activeWorkerRequestId = null;
    }
  },
  onCompileLoad: async (req, numericId) => {
    const workerId = workerRequestIdFromNumeric(numericId);
    if (activeWorkerRequestId && activeWorkerRequestId !== workerId) {
      engineeringClient.cancel(activeWorkerRequestId);
    }
    activeWorkerRequestId = workerId;
    try {
      let payload: unknown = req.source;
      if (payload instanceof File) {
        payload = await payload.text();
      }
      const response = await engineeringClient.compileSimulate(
        workerId,
        payload,
      );
      const hydrated = hydrateEngineeringSuccess(response);
      const result: AuthoritativeExperienceResult = {
        file: hydrated.file,
        track: hydrated.track,
        timeline: hydrated.timeline,
        diagnostics: hydrated.diagnostics,
        relaxations: hydrated.relaxations,
        spanHashes: hydrated.spanHashes,
      };
      controller.setResult(result, numericId);
      lastFailureDiagnostics = [];
      lastFailureRelaxations = [];
    } catch (e) {
      const err = normalizeEngineeringError(e);
      if (err.code === "cancelled") {
        controller.setError("Cancelled", numericId);
        return;
      }
      if (err.diagnostics) {
        lastFailureDiagnostics = err.diagnostics;
        renderDiagnostics(lastFailureDiagnostics);
      } else {
        lastFailureDiagnostics = [
          {
            code: "LOAD_ERROR",
            severity: "error",
            provenance: "PROJECT_ENGINEERING_LIMIT",
            message: err.message,
          },
        ];
        renderDiagnostics(lastFailureDiagnostics);
      }
      controller.setError(err.message, numericId);
    } finally {
      if (activeWorkerRequestId === workerId) activeWorkerRequestId = null;
    }
  },
  onSave: async (req) => {
    const { url, timerId } = downloadCoasterFile(req.file, "vibecoaster");
    pendingObjectUrls.push(url);
    pendingRevokeTimers.push(timerId);
  },
  onExport: async (req) => {
    const { url, timerId } = downloadCoasterFile(
      req.file,
      "vibecoaster-export",
    );
    pendingObjectUrls.push(url);
    pendingRevokeTimers.push(timerId);
  },
  onElementSelectionChanged: (elementId) => {
    if (elementId) {
      pinBtn.dataset.pinned = String(
        controller.getState().pinnedElementIds.includes(elementId),
      );
      pinBtn.setAttribute(
        "aria-pressed",
        String(pinBtn.dataset.pinned === "true"),
      );
      pinBtn.textContent = pinBtn.dataset.pinned === "true" ? "Pinned" : "Pin";
      inspector.classList.toggle("is-pinned", pinBtn.dataset.pinned === "true");
    }
  },
  onTimelineSelectionChanged: (selection) => {
    // Update highlight and scrubber
    lifecycle.setHighlight(selection.distanceM);
    const authoritative = getAuthoritativeResult();
    const timeline = authoritative?.timeline ?? null;
    if (timeline) {
      const ratio = (selection.index / (timeline.length - 1)) * 1000;
      scrubber.value = String(Math.round(ratio));
      scrubberValue.textContent = `${scrubber.value} / ${scrubber.max}`;
      selectionReadout.textContent = `Distance ${selection.distanceM.toFixed(1)} m — time ${selection.timeSeconds.toFixed(2)} s at ${timeline.speedMps[selection.index]?.toFixed(1) ?? "0"} m/s`;
      if (trackHighlightEl)
        trackHighlightEl.setAttribute(
          "data-highlight-distance",
          String(selection.distanceM),
        );
      if (trainPositionEl) {
        trainPositionEl.setAttribute(
          "data-distance-m",
          String(selection.distanceM),
        );
        trainPositionEl.setAttribute(
          "data-speed-mps",
          String(timeline.speedMps[selection.index] ?? 0),
        );
      }
      // Draw graph selection line
      if (timeline && authoritative?.track) {
        if (isSeatMetric(state.metric)) {
          const seatId = getCurrentSeatId();
          const series = getSeatMetricSeries(
            state.metric,
            authoritative,
            seatId,
          );
          drawTimelineGraph(telemetryGraph, series, selection.index);
        } else {
          const series = getMetricSeries(
            state.metric,
            authoritative.track,
            timeline,
            authoritative.clearanceM ?? null,
          );
          drawTimelineGraph(telemetryGraph, series, selection.index);
        }
      }
    }
    syncTelemetryGraphA11y();
  },
});

function syncTelemetryGraphA11y(): void {
  const auth = getAuthoritativeResult();
  const timeline = auth?.timeline ?? null;
  const maxIdx = timeline ? Math.max(0, timeline.length - 1) : 0;
  const selIdx = controller.getState().timelineSelection?.index ?? null;
  const snapshotIdx = ridePlayback?.getSnapshot().sampleIndex ?? null;
  const current = snapshotIdx ?? selIdx ?? 0;
  telemetryGraph.setAttribute("aria-valuemax", String(maxIdx));
  telemetryGraph.setAttribute(
    "aria-valuenow",
    String(Math.max(0, Math.min(maxIdx, current))),
  );
  if (timeline) {
    telemetryGraph.setAttribute(
      "aria-label",
      `Telemetry graph — ${state.metric} scrubber, sample ${current + 1} of ${timeline.length}`,
    );
    telemetryGraph.setAttribute(
      "aria-valuetext",
      `sample ${current + 1} of ${timeline.length}`,
    );
  }
}

// Subscribe once to ExperienceController
unsubscribeController = controller.subscribe((expState) => {
  // Sync generationStatus to viewState state
  const prevStatus = state.generationStatus;
  state.generationStatus = expState.status as AppState["generationStatus"];
  // Store current result references
  if (expState.status === "pending" || expState.status === "generating") {
    if (expState.status === "pending") {
      lastFailureDiagnostics = [];
      lastFailureRelaxations = [];
      renderDiagnostics([]);
      renderRelaxations([]);
      elementList.innerHTML = "";
      if (trackLengthEl) {
        trackLengthEl.textContent = "Length —";
        trackLengthEl.removeAttribute("data-length-m");
      }
      if (compiledChecksumEl) {
        compiledChecksumEl.textContent = "Checksum —";
        compiledChecksumEl.removeAttribute("data-checksum");
      }
      if (seamBoundariesEl) {
        seamBoundariesEl.textContent = "Seams —";
        seamBoundariesEl.setAttribute("data-count", "0");
      }
      if (timelineDurationEl) {
        timelineDurationEl.textContent = "Timeline —";
        timelineDurationEl.removeAttribute("data-duration-s");
      }
      if (telemetrySignatureEl) {
        telemetrySignatureEl.textContent = "Telemetry —";
        telemetrySignatureEl.removeAttribute("data-signature");
      }
    }
  }

  if (expState.status === "ready" && expState.result) {
    const result = expState.result;
    const track = result.track;
    const timeline = result.timeline;
    const initialSeat: RideSelectionId = getCurrentSeatId();
    const seatMetricAvailable = isSeatMetric(state.metric);
    const metricData = seatMetricAvailable
      ? deriveSeatMetricData(state.metric, result, initialSeat)
      : deriveMetricData(state.metric, result);

    // Attach track through lifecycle — handle WebGL failure queuing
    try {
      lifecycle.attachTrack(result.track, {
        metric: state.metric,
        metricData,
        timeline: {
          distances: result.timeline.headDistanceM,
          speeds: result.timeline.speedMps,
        },
        closedTrack: false,
      });
    } catch {
      hasWebGL = false;
      truthfulDowngrade();
      render();
    }

    // Populate DOM
    renderDiagnostics(result.diagnostics);
    renderRelaxations(result.relaxations ?? []);
    renderElementList(result.track, result.spanHashes, result.file);
    updateReadoutsForResult(result);

    renderMetricLegend(state.metric);
    lifecycle.setMetric(state.metric, metricData);

    {
      const series = seatMetricAvailable
        ? getSeatMetricSeries(state.metric, result, initialSeat)
        : getMetricSeries(
            state.metric,
            track,
            timeline,
            result.clearanceM ?? null,
          );
      drawTimelineGraph(telemetryGraph, series, getSelectedTimelineIndex());
    }

    seamInspectBtn.setAttribute(
      "aria-pressed",
      String(controller.getState().seamInspection),
    );
    if (seamBoundariesEl) {
      const semanticSeams = getSemanticSeamIndices(result.file, track);
      const seamState = getSeamInspection(
        track,
        result.diagnostics,
        controller.getState().seamInspection,
        semanticSeams,
      );
      seamBoundariesEl.setAttribute(
        "data-count",
        String(seamState.boundaries.length),
      );
      lifecycle.setSeamInspection(controller.getState().seamInspection, [
        ...seamState.boundaries,
      ]);
    }

    // Ride playback: own one createRidePlayback per accepted timeline; dispose prior
    if (unsubscribeRidePlayback) {
      try {
        unsubscribeRidePlayback();
      } catch {}
      unsubscribeRidePlayback = null;
    }
    if (ridePlayback) {
      try {
        ridePlayback.dispose();
      } catch {}
      ridePlayback = null;
    }
    try {
      const initialRate: AllowedRate = isAllowedRate(state.playbackSpeed)
        ? state.playbackSpeed
        : 1;
      ridePlayback = createRidePlayback(timeline, {
        reducedMotion: state.reducedMotion,
        rate: initialRate,
        camera: state.camera as "front" | "middle" | "rear" | "chase" | "orbit",
        selectedSeat: "front",
      });
      unsubscribeRidePlayback = ridePlayback.subscribe((snap) => {
        syncPlaybackControlsFromSnapshot(snap);
      });
      ridePlayback.pause();
      const snap = ridePlayback.getSnapshot();
      lifecycle.updatePlayback(snap.headDistanceM, snap.speedMps, snap);
      syncPlaybackControlsFromSnapshot(snap);
    } catch {
      // contained playback creation failure remains visible via error status without console
    }

    // Audio: own one procedural createRideAudioEngine per track/timeline with actual zone names/masks
    if (audioEngine) {
      try {
        audioEngine.dispose();
      } catch {}
      audioEngine = null;
    }
    try {
      const zoneNames = track.zoneNames;
      const lsmMask = zoneNames.reduce(
        (m, name, idx) =>
          name === "launch" || name === "boost" ? m | (1 << idx) : m,
        0,
      );
      const brakeMask = zoneNames.reduce(
        (m, name, idx) => (name === "brake" ? m | (1 << idx) : m),
        0,
      );
      audioEngine = createRideAudioEngine({
        zoneNames,
        lsmZoneMask: lsmMask,
        brakeZoneMask: brakeMask,
      });
      // mute state sync
      audioEngine.setMuted(state.isMuted);
      if (ridePlayback) {
        const snap = ridePlayback.getSnapshot();
        const zoneMask = resolveZoneMask(track, snap.headDistanceM);
        audioEngine.update({
          speedMps: snap.speedMps,
          zoneMask,
          paused: !snap.isPlaying,
        });
      }
      updateAudioStatus();
    } catch {
      // Unsupported audio is visible/operable without console/page errors -> set to null but keep mute operable
      audioEngine = null;
      updateAudioStatus();
    }

    // Selection readout initial
    if (expState.selectedElementId) {
      selectionReadout.textContent = `Selected ${expState.selectedElementId} — distance ${track.distances[0]?.toFixed(1) ?? "0"} m`;
    } else {
      selectionReadout.textContent = `No selection. Distance ${timeline.headDistanceM[0]?.toFixed(1) ?? "0"} m — time ${timeline.timeSeconds[0]?.toFixed(2) ?? "0"} s at ${timeline.speedMps[0]?.toFixed(1) ?? "0"} m/s`;
    }

    // Update scrubber max etc
    scrubber.max = "1000";
    scrubber.value = "0";
    scrubberValue.textContent = `0 / ${scrubber.max}`;
    syncTelemetryGraphA11y();
  } else if (expState.status === "error") {
    // Error state: retain WebGL queue but show diagnostics/relaxations from failure
    if (lastFailureDiagnostics.length > 0) {
      renderDiagnostics(lastFailureDiagnostics);
    } else if (expState.lastGoodResult) {
      // show last good diagnostics? but failure should show error diagnostics
      renderDiagnostics(expState.lastGoodResult.diagnostics);
    } else {
      renderDiagnostics([]);
    }
    const relaxToShow =
      lastFailureRelaxations.length > 0
        ? lastFailureRelaxations
        : (expState.result?.relaxations ?? []);
    renderRelaxations(relaxToShow);
    // Seam toggle persists but count maybe from last good
    seamInspectBtn.setAttribute(
      "aria-pressed",
      String(expState.seamInspection),
    );
    const errorAuthoritative = expState.lastGoodResult ?? expState.result;
    if (seamBoundariesEl && errorAuthoritative?.track) {
      const semanticSeams = getSemanticSeamIndices(
        errorAuthoritative.file,
        errorAuthoritative.track,
      );
      const seamState = getSeamInspection(
        errorAuthoritative.track,
        lastFailureDiagnostics,
        expState.seamInspection,
        semanticSeams,
      );
      seamBoundariesEl.setAttribute(
        "data-count",
        String(seamState.boundaries.length),
      );
    }
    // Metric legend still updates
    renderMetricLegend(state.metric);
    // Graph: if we have authoritative, draw with selection?
    if (errorAuthoritative?.timeline && errorAuthoritative?.track) {
      const s = getMetricSeries(
        state.metric,
        errorAuthoritative.track,
        errorAuthoritative.timeline,
        errorAuthoritative.clearanceM ?? null,
      );
      drawTimelineGraph(telemetryGraph, s, getSelectedTimelineIndex());
    }
  } else if (expState.status === "generating") {
    // Disable generate etc via render()
  }

  if (expState.status === "error") {
    visibleErrorMessage = expState.error;
  } else {
    visibleErrorMessage = null;
  }

  // Always re-render view state
  render();
  // Ensure reduced motion class etc

  // Preserve one renderer lifecycle/RAF and one resize owner already

  // For transition from generating to ready, measure total generation time if started
  if (
    prevStatus === "generating" &&
    expState.status === "ready" &&
    generationStartMark !== null
  ) {
    try {
      const dur = performance.now() - generationStartMark;
      performance.measure("ovc:generation-total", {
        duration: dur,
      });
    } catch {}
    generationStartMark = null;
  }
  if (expState.status === "error" || expState.status === "pending") {
    generationStartMark = null;
  }
});

// Helpers for playback DOM sync already defined

function handleGenerateClick(): void {
  if (!getActionEnabled("generate", controller.getState().status)) return;
  const rawSeed = seedInput.value.trim();
  const mode = getGenerationMode() as "insta" | "full-auto" | "directed";
  if (mode === "directed") {
    const directed = readDirectedControls();
    if (directed.errors.length > 0 || !directed.intent) {
      lastFailureDiagnostics = directed.errors.map((e) => ({
        code: "INVALID_INTENT",
        severity: "error" as const,
        provenance: "PROJECT_ENGINEERING_LIMIT" as const,
        message: `${e.field}: ${e.message}`,
      }));
      renderDiagnostics(lastFailureDiagnostics);
      renderRelaxations([]);
      controller.setError(
        directed.errors.map((e) => `${e.field}: ${e.message}`).join("; ") ||
          "Invalid directed input",
      );
      return;
    }
    const seedVal = parseUint32Seed(rawSeed);
    if (seedVal === null) {
      lastFailureDiagnostics = [
        {
          code: "INVALID_SEED",
          severity: "error",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: "seed: expected uint32 integer",
        },
      ];
      renderDiagnostics(lastFailureDiagnostics);
      controller.setError("seed: expected uint32 integer");
      return;
    }
    if (!directed.editorInput) return;
    state.seed = String(seedVal);
    controller.requestGenerate({
      mode: "directed",
      input: directed.editorInput,
    });
  } else {
    const parsed = parseUint32Seed(rawSeed);
    if (parsed === null) {
      lastFailureDiagnostics = [
        {
          code: "INVALID_SEED",
          severity: "error",
          provenance: "PROJECT_ENGINEERING_LIMIT",
          message: "seed: expected uint32 integer",
        },
      ];
      renderDiagnostics(lastFailureDiagnostics);
      controller.setError("seed: expected uint32 integer");
      return;
    }
    state.seed = String(parsed);
    controller.requestGenerate({ mode, seed: parsed });
  }
}

generateBtn.addEventListener("click", handleGenerateClick, {
  signal: abortSignal,
});

cancelGenerationBtn.addEventListener("click", () => {
  const capturedRequestId = controller.getState().requestId;
  if (activeWorkerRequestId) {
    engineeringClient.cancel(activeWorkerRequestId);
    activeWorkerRequestId = null;
  }
  controller.setError("Cancelled", capturedRequestId);
});

// Save/export already via controller requestSave callbacks, but need UI wiring
saveBtn.addEventListener("click", () => {
  if (!getActionEnabled("save", controller.getState().status)) return;
  controller.requestSave();
});
exportBtn.addEventListener("click", () => {
  if (!getActionEnabled("export", controller.getState().status)) return;
  controller.requestExport("json");
});
loadBtn.addEventListener("click", () => {
  loadFile.click();
});
loadFile.addEventListener("change", () => {
  const file = loadFile.files?.[0];
  if (!file) return;
  // Validate via controller path: read without fetch
  // Directly requestLoad, which will trigger compileSimulate
  controller.requestLoad(file);
  loadFile.value = "";
});

// Seed input sync
seedInput.addEventListener("input", () => {
  state.seed = seedInput.value.slice(0, 64);
});
seedInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleGenerateClick();
  }
});

for (const input of modeInputs) {
  input.addEventListener("change", () => {
    if (input.checked) {
      state.appMode = input.value as AppState["appMode"];
      render();
    }
  });
}

for (const input of cameraInputs) {
  input.addEventListener("change", () => {
    if (input.checked) {
      try {
        state.camera = selectCamera(input.value as CameraId, state.camera);
        if (ridePlayback) {
          ridePlayback.setCamera(
            state.camera as "front" | "middle" | "rear" | "chase" | "orbit",
          );
        }
        lifecycle.getController()?.applyCamera(state.camera, {
          reducedMotion: state.reducedMotion,
          deltaMs: 16,
          snapshot: ridePlayback?.getSnapshot() ?? null,
        });
      } catch (error) {
        handleVisibleUnexpectedError(error);
        return;
      }
      render();
    }
  });
}

metricSelect.addEventListener("change", () => {
  state.metric = selectMetric(metricSelect.value as MetricId, state.metric);
  const authoritative = getAuthoritativeResult();
  if (authoritative) {
    const seatId = getCurrentSeatId();
    if (isSeatMetric(state.metric)) {
      const metricData = deriveSeatMetricData(
        state.metric,
        authoritative,
        seatId,
      );
      const series = getSeatMetricSeries(state.metric, authoritative, seatId);
      renderMetricLegend(state.metric);
      drawTimelineGraph(telemetryGraph, series, getSelectedTimelineIndex());
      lifecycle.setMetric(state.metric, metricData);
    } else {
      const series = getMetricSeries(
        state.metric,
        authoritative.track,
        authoritative.timeline,
        authoritative.clearanceM ?? null,
      );
      renderMetricLegend(state.metric);
      drawTimelineGraph(telemetryGraph, series, getSelectedTimelineIndex());
      const metricData = deriveMetricData(state.metric, authoritative);
      lifecycle.setMetric(state.metric, metricData);
    }
  } else {
    lifecycle.setMetric(state.metric);
    renderMetricLegend(state.metric);
  }
  render();
});

seatSelect.addEventListener("change", () => {
  const opt = getSeatOptionByValue(seatSelect.value);
  if (!opt) {
    const snap = ridePlayback?.getSnapshot();
    const fallback = snap ? getSeatValueFromSnapshot(snap) : "front";
    seatSelect.value = fallback;
    return;
  }
  if (ridePlayback) {
    ridePlayback.selectSeat(opt.seatId, opt.seatIndex);
  } else {
    state.seatIndex =
      opt.seatId === "front" ? 0 : opt.seatId === "rear" ? 2 : 1;
    render();
  }
});

playbackSelect.addEventListener("change", () => {
  const parsed = Number.parseFloat(playbackSelect.value);
  if (!isAllowedRate(parsed)) {
    playbackSelect.value = String(state.playbackSpeed);
    return;
  }
  if (ridePlayback) {
    ridePlayback.setRate(parsed);
  } else {
    state.playbackSpeed = parsed;
    render();
  }
});

scrubber.addEventListener("input", () => {
  scrubberValue.textContent = `${scrubber.value} / ${scrubber.max}`;
  const scrubAuthoritative = getAuthoritativeResult();
  const scrubTimeline = scrubAuthoritative?.timeline ?? null;
  const scrubTrack = scrubAuthoritative?.track ?? null;
  if (scrubTimeline && scrubTrack && ridePlayback) {
    const t =
      Number.parseInt(scrubber.value, 10) / Number.parseInt(scrubber.max, 10);
    const idx = Math.round(t * (scrubTimeline.length - 1));
    const selection = controller.selectTimelineIndex(idx);
    if (selection) {
      ridePlayback.scrubIndex(idx);
      lifecycle.setHighlight(selection.distanceM);
    } else {
      const dist = t * scrubTrack.totalLength;
      lifecycle.updatePlayback(dist, 0);
    }
    syncTelemetryGraphA11y();
  }
});

// Graph click
telemetryGraph.addEventListener("click", (event) => {
  const graphAuthoritative = getAuthoritativeResult();
  const graphTimeline = graphAuthoritative?.timeline ?? null;
  const graphTrack = graphAuthoritative?.track ?? null;
  if (!graphTimeline || !graphTrack) return;
  const rect = telemetryGraph.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const width = rect.width;
  const idx = indexAtGraphPosition(graphTimeline, x, width);
  const sel = controller.selectTimelineIndex(idx);
  if (sel && ridePlayback) {
    ridePlayback.scrubIndex(idx);
  }
  syncTelemetryGraphA11y();
});

telemetryGraph.addEventListener("keydown", (event) => {
  const action = getCanvasKeyboardAction(event.key);
  if (action === "none") return;
  const graphAuthoritative = getAuthoritativeResult();
  const graphTimeline = graphAuthoritative?.timeline ?? null;
  if (!graphTimeline || graphTimeline.length === 0 || !ridePlayback) return;
  event.preventDefault();
  const currentIdx =
    controller.getState().timelineSelection?.index ??
    ridePlayback.getSnapshot().sampleIndex;
  const nextIdx = getTelemetryNextIndex(
    currentIdx,
    event.key,
    graphTimeline.length,
  );
  if (nextIdx === currentIdx) return;
  const selection = controller.selectTimelineIndex(nextIdx);
  if (selection) {
    ridePlayback.scrubIndex(nextIdx);
    lifecycle.setHighlight(selection.distanceM);
  }
  syncTelemetryGraphA11y();
});

pauseBtn.addEventListener("click", () => {
  if (!getActionEnabled("playback", controller.getState().status)) return;
  if (!ridePlayback) return;
  const snap = ridePlayback.getSnapshot();
  if (snap.isPlaying) ridePlayback.pause();
  else ridePlayback.play();
});

resetBtn.addEventListener("click", () => {
  if (!getActionEnabled("playback", controller.getState().status)) return;
  if (!ridePlayback) return;
  ridePlayback.reset();
  const snap = ridePlayback.getSnapshot();
  controller.selectTimelineIndex(snap.sampleIndex);
  lifecycle.setHighlight(snap.headDistanceM);
});

seamInspectBtn.addEventListener("click", () => {
  if (!getActionEnabled("seamInspect", controller.getState().status)) return;
  const current = controller.getState().seamInspection;
  const next = !current;
  controller.setSeamInspection(next);
  seamInspectBtn.setAttribute("aria-pressed", String(next));
  // Use canonical boundaries/diagnostics, not timeout animation
  const seamAuth2 = getAuthoritativeResult();
  if (seamAuth2?.track) {
    const semanticSeams = getSemanticSeamIndices(
      seamAuth2.file,
      seamAuth2.track,
    );
    const seamState = getSeamInspection(
      seamAuth2.track,
      seamAuth2.diagnostics,
      next,
      semanticSeams,
    );
    lifecycle.setSeamInspection(next, [...seamState.boundaries]);
    if (seamBoundariesEl)
      seamBoundariesEl.setAttribute(
        "data-count",
        String(seamState.boundaries.length),
      );
  }
});

localRegenerateBtn.addEventListener("click", () => {
  if (!getActionEnabled("localRegenerate", controller.getState().status))
    return;
  const selId = getSelectedElementId();
  if (!selId) {
    // No selection, pick first unpinned?
    controller.requestLocalRegenerate();
    return;
  }
  // Check if inspector has edited value: apply edit before regenerate
  const lengthVal = (
    document.getElementById("inspect-length") as HTMLInputElement
  )?.value;
  if (lengthVal && lengthVal.trim() !== "") {
    const num = Number.parseFloat(lengthVal);
    if (Number.isFinite(num)) {
      controller.editElementParameter(selId, "length", num);
    }
  }
  controller.requestLocalRegenerate();
});

pinBtn.addEventListener("click", () => {
  const id = getSelectedElementId();
  if (!id) return;
  const wasPinned = controller.getState().pinnedElementIds.includes(id);
  controller.togglePin(id);
  const nowPinned = !wasPinned;
  pinBtn.dataset.pinned = String(nowPinned);
  pinBtn.setAttribute("aria-pressed", String(nowPinned));
  pinBtn.textContent = nowPinned ? "Pinned" : "Pin";
  inspector.classList.toggle("is-pinned", nowPinned);
});

// Inspector edits: listen to inputs and call editElementParameter
for (const input of inspectInputs) {
  input.addEventListener("change", () => {
    const id = getSelectedElementId();
    if (!id) return;
    const paramMap: Record<string, string> = {
      "inspect-length": "length",
      "inspect-radius": "radius",
      "inspect-height": "height",
      "inspect-roll": "roll",
    };
    const param = paramMap[input.id] ?? input.id;
    const val = input.value.trim();
    const num = Number.parseFloat(val);
    const value = Number.isFinite(num) ? num : val;
    controller.editElementParameter(id, param, value);
  });
}

// Mobile drawers
for (const tab of mobileTabs) {
  tab.addEventListener("click", () => {
    const target = tab.dataset.drawer;
    const isOpen = tab.getAttribute("aria-expanded") === "true";
    for (const other of mobileTabs) {
      other.setAttribute("aria-expanded", "false");
    }
    generationRail.classList.remove("is-open");
    inspector.classList.remove("is-open");
    telemetry.classList.remove("is-open");
    if (!isOpen) {
      tab.setAttribute("aria-expanded", "true");
      if (target === "left") generationRail.classList.add("is-open");
      else if (target === "right") inspector.classList.add("is-open");
      else if (target === "telemetry") telemetry.classList.add("is-open");
    }
  });
}

// Keyboard shortcuts: M for mute, Space for pause when not typing (keep existing)
document.addEventListener(
  "keydown",
  (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (isShortcutOwnerElement(target)) return;
    if (event.key === "m" || event.key === "M") {
      state.isMuted = !state.isMuted;
      if (audioEngine) audioEngine.setMuted(state.isMuted);
      updateAudioStatus();
      render();
    } else if (event.key === " ") {
      event.preventDefault();
      if (
        getActionEnabled("playback", controller.getState().status) &&
        ridePlayback
      ) {
        const snap = ridePlayback.getSnapshot();
        if (snap.isPlaying) ridePlayback.pause();
        else if (!snap.ended) ridePlayback.play();
      }
    } else if (event.key === "r" || event.key === "R") {
      const nextMode: AppState["appMode"] =
        state.appMode === "ride" ? "edit" : "ride";
      state.appMode = nextMode;
      render();
    }
  },
  { signal: abortSignal },
);

audioUnlockBtn.addEventListener("click", async () => {
  if (!audioEngine) return;
  try {
    await audioEngine.unlock();
  } catch {}
  updateAudioStatus();
  render();
});
muteBtn.addEventListener("click", () => {
  state.isMuted = !state.isMuted;
  if (audioEngine) {
    try {
      audioEngine.setMuted(state.isMuted);
    } catch {}
  }
  updateAudioStatus();
  render();
});

// Reduced motion live query
prefersReducedMotionQuery.addEventListener(
  "change",
  (event) => {
    state.reducedMotion = getReducedMotionState(event.matches, null);
    if (ridePlayback) {
      ridePlayback.setReducedMotion(state.reducedMotion);
    }
    render();
  },
  { signal: abortSignal },
);

// Mode toggle (app-mode edit/ride already handled, but also generation mode radios are just read at generation time)

// Teardown
function teardown(): void {
  try {
    if (activeWorkerRequestId) {
      engineeringClient.cancel(activeWorkerRequestId);
      activeWorkerRequestId = null;
    }
  } catch {}
  try {
    engineeringClient.teardown();
  } catch {}
  try {
    unsubscribeRidePlayback?.();
  } catch {}
  unsubscribeRidePlayback = null;
  try {
    ridePlayback?.dispose();
  } catch {}
  try {
    audioEngine?.dispose();
  } catch {}
  try {
    unsubscribeController?.();
  } catch {}
  try {
    lifecycle.dispose();
  } catch {}
  for (const id of pendingRevokeTimers) {
    try {
      clearTimeout(id);
    } catch {}
  }
  pendingRevokeTimers = [];
  for (const url of pendingObjectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  pendingObjectUrls = [];
  try {
    abortController.abort();
  } catch {}
}

window.addEventListener("beforeunload", teardown, { signal: abortSignal });
window.addEventListener("pagehide", teardown, { signal: abortSignal });

// Minimal read-only dev/test snapshot API returning frozen primitives only – no handle/controller/scene/renderer/state/metrics references
function __vibecoasterSnapshot(): Readonly<{
  rendererReady: boolean;
  successfulRenderCount: number;
  generationStatus: string;
  hasWebGL: boolean;
  reducedMotion: boolean;
  appMode: string;
  cameraX: number;
  cameraY: number;
  cameraZ: number;
  intentFootprint: readonly import("@openvibecoaster/core").Vec3[] | undefined;
  intentHeightRange: import("@openvibecoaster/core").HeightRangeV1 | undefined;
  gateContradictions: readonly import("@openvibecoaster/core").Diagnostic[];
  railColorHash: string | null;
  seamSignature: string | null;
  highlightDistance: number | null;
  trainWorldPositions: readonly [number, number, number][] | null;
}> {
  const cam = lifecycle.getCamera();
  const loaded =
    controller.getState().result ?? controller.getState().lastGoodResult;
  const intent = loaded?.file.intent ?? null;
  const intentFootprint = intent?.footprint;
  const intentHeightRange = intent?.heightRange;
  let gateContradictions: readonly import("@openvibecoaster/core").Diagnostic[] =
    Object.freeze([]);
  if (intent && intentFootprint && intentHeightRange) {
    const polygon: [number, number][] = intentFootprint.map((v) => [
      v[0],
      v[2],
    ]);
    const gates: DirectedGateInput[] = intent.gates.map((g) => ({
      position: [g.position[0], g.position[1], g.position[2]],
    }));
    const input: DirectedEditorInput = {
      seed: intent.seed,
      gates,
      footprint: {
        polygon,
        maxHeightM: intentHeightRange.max,
        minHeightM: intentHeightRange.min,
      },
      terrainProfileId: intent.terrainProfileId ?? "rolling-highlands-v1",
      requiredElements: [],
      hardTargets: [],
      softTargets: [],
      pinnedElementIds: [],
    };
    gateContradictions = detectGateContradictions(input);
  }
  const diag = lifecycle.getController()?.getDiagnosticSnapshot() ?? null;
  return Object.freeze({
    rendererReady: lifecycle.isRendererReady(),
    successfulRenderCount: lifecycle.getSuccessfulRenderCount(),
    generationStatus: state.generationStatus,
    hasWebGL,
    reducedMotion: state.reducedMotion,
    appMode: state.appMode,
    cameraX: cam ? cam.position.x : 0,
    cameraY: cam ? cam.position.y : 0,
    cameraZ: cam ? cam.position.z : 0,
    intentFootprint,
    intentHeightRange,
    gateContradictions,
    railColorHash: diag?.railColorHash ?? null,
    seamSignature: diag?.seamSignature ?? null,
    highlightDistance: diag?.highlightDistance ?? null,
    trainWorldPositions: diag?.trainWorldPositions ?? null,
  });
}
window.__vibecoasterSnapshot = __vibecoasterSnapshot;

// Initial paint – lifecycle manager is sole resize owner (no duplicate direct resize)
render();

// Expose for manual inspection in devtools (not used in tests)
declare global {
  interface Window {
    __vibecoasterSnapshot?: typeof __vibecoasterSnapshot;
  }
}
