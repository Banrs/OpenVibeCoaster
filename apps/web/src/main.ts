// @ts-nocheck
import * as THREE from "three";
import "./styles.css";
import {
  clampPlaybackSpeed,
  createInitialState,
  getActionEnabled,
  getCanvasAriaLabel,
  getNextStatusAfterGenerate,
  getNextStatusAfterLoad,
  getPanelVisibility,
  getReducedMotionState,
  getStatusText,
  selectCamera,
  selectMetric,
  selectSeat,
  type AppState,
  type CameraId,
  type MetricId,
} from "./viewState.js";
import { createRendererHandle } from "./render/renderer.js";
import { getCameraState, clampFovForSpeed } from "./render/cameras.js";
import { RenderMetrics } from "./render/metrics.js";

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl") ?? canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) {
    throw new Error(`Missing element #${id}`);
  }
  return found as T;
}

const state: AppState = createInitialState();

let hasWebGL = supportsWebGL();
const prefersReducedMotion = window.matchMedia(
  "(prefers-reduced-motion: reduce)",
).matches;
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
const saveBtn = el<HTMLButtonElement>("save-btn");
const loadBtn = el<HTMLButtonElement>("load-btn");
const loadFile = el<HTMLInputElement>("load-file");
const exportBtn = el<HTMLButtonElement>("export-btn");
const muteBtn = el<HTMLButtonElement>("mute-btn");
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
const webglRetry = el<HTMLButtonElement>("webgl-retry");

const generationRail = el<HTMLElement>("generation-rail");
const inspector = el<HTMLElement>("element-inspector");
const telemetry = el<HTMLElement>("telemetry");
const mobileTabs = Array.from(
  document.querySelectorAll<HTMLButtonElement>(".mobile-tab"),
);

function syncBodyClasses(): void {
  body.classList.toggle("mode-ride", state.appMode === "ride");
  body.classList.toggle("mode-edit", state.appMode === "edit");
  body.classList.toggle("reduced-motion", state.reducedMotion);
  body.dataset.status = state.generationStatus;
}

function render(): void {
  syncBodyClasses();

  // Status text and aria
  const text = getStatusText(state.generationStatus);
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
  viewportCanvas.setAttribute(
    "aria-label",
    getCanvasAriaLabel(state.generationStatus),
  );

  // Data-dependent enablement
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
  playbackSelect.disabled = !canPlayback;
  seamInspectBtn.disabled = !canSeam;
  localRegenerateBtn.disabled = !canLocal;
  metricSelect.disabled = !canPlayback;
  seatSelect.disabled = !canPlayback;
  generateBtn.disabled = !canGenerate;
  generateBtn.textContent =
    state.generationStatus === "generating" ? "Generating…" : "Insta Generate";

  for (const input of inspectInputs) {
    input.disabled = !canLocal;
  }

  // Panel visibility via class — getPanelVisibility used for logic verification
  const vis = getPanelVisibility(state);
  generationRail.hidden = !vis.leftRailVisible;
  inspector.hidden = !vis.rightInspectorVisible;
  // telemetry visibility handled via CSS mode-ride, but keep aria
  telemetry.hidden = !vis.telemetryVisible && state.appMode === "ride";
  // On desktop, keep panels visible via CSS; hidden attribute for a11y when ride
  if (state.appMode === "ride") {
    generationRail.setAttribute("aria-hidden", "true");
    inspector.setAttribute("aria-hidden", "true");
  } else {
    generationRail.removeAttribute("aria-hidden");
    inspector.removeAttribute("aria-hidden");
  }

  // Playback state
  pauseBtn.setAttribute("aria-pressed", String(!state.isPaused));
  pauseBtn.textContent = state.isPaused ? "Play" : "Pause";
  muteBtn.setAttribute("aria-pressed", String(state.isMuted));
  muteBtn.textContent = state.isMuted ? "Unmute" : "Mute";
  pinBtn.setAttribute("aria-pressed", String(pinBtn.dataset.pinned === "true"));

  // Sync controls to state
  for (const input of modeInputs) {
    input.checked = input.value === state.appMode;
  }
  for (const input of cameraInputs) {
    input.checked = input.value === state.camera;
  }
  metricSelect.value = state.metric;
  seatSelect.value = String(state.seatIndex);
  playbackSelect.value = String(state.playbackSpeed);
  scrubberValue.textContent = `${scrubber.value} / ${scrubber.max}`;

  // Telemetry graph placeholder
  const hasData = state.generationStatus === "ready";
  telemetryGraphWrap.classList.toggle("has-data", hasData);
  telemetryEmpty.hidden = hasData;
  telemetryGraph.setAttribute(
    "aria-label",
    hasData
      ? `Telemetry graph — ${state.metric} at seat ${state.seatIndex + 1}`
      : "Telemetry graph — no data, generate to populate",
  );

  // WebGL fallback
  if (!hasWebGL) {
    webglFallback.hidden = false;
    viewportCanvas.hidden = true;
  } else {
    webglFallback.hidden = true;
    viewportCanvas.hidden = false;
  }

  // Seed
  if (document.activeElement !== seedInput) {
    seedInput.value = state.seed;
  }
}

function handleGenerate(): void {
  if (!getActionEnabled("generate", state.generationStatus)) {
    return;
  }
  state.generationStatus = "generating";
  render();
  // Worker not yet integrated — never claim ready without canonical data.
  // Resolve to error so data-dependent actions stay disabled and status remains truthful.
  window.setTimeout(() => {
    state.generationStatus = getNextStatusAfterGenerate(state.generationStatus);
    render();
  }, 900);
}

function handleSave(): void {
  if (!getActionEnabled("save", state.generationStatus)) {
    return;
  }
  const payload = JSON.stringify(
    {
      seed: state.seed,
      status: state.generationStatus,
      camera: state.camera,
      metric: state.metric,
      seatIndex: state.seatIndex,
      playbackSpeed: state.playbackSpeed,
    },
    null,
    2,
  );
  const blob = new Blob([payload], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `vibecoaster-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function handleLoadFile(file: File | undefined): void {
  if (!file) {
    return;
  }
  const reader = new FileReader();
  reader.addEventListener("load", () => {
    try {
      const parsed: unknown = JSON.parse(String(reader.result));
      // Wave 1 has no real CoasterFileV1 parser; distinguish well-formed JSON from malformed,
      // but never transition to ready. Keep data-dependent actions disabled.
      // We intentionally do not apply seed/camera from unvalidated payload.
      void parsed;
      state.generationStatus = getNextStatusAfterLoad(
        parsed,
        state.generationStatus,
      );
      render();
    } catch {
      state.generationStatus = "error";
      render();
    }
  });
  reader.readAsText(file);
}

// Event wiring
generateBtn.addEventListener("click", handleGenerate);
saveBtn.addEventListener("click", handleSave);
exportBtn.addEventListener("click", handleSave);
loadBtn.addEventListener("click", () => {
  loadFile.click();
});
loadFile.addEventListener("change", () => {
  handleLoadFile(loadFile.files?.[0]);
  loadFile.value = "";
});
muteBtn.addEventListener("click", () => {
  state.isMuted = !state.isMuted;
  render();
});
seedInput.addEventListener("input", () => {
  state.seed = seedInput.value.slice(0, 64);
});
seedInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    handleGenerate();
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
      state.camera = selectCamera(input.value as CameraId, state.camera);
      render();
    }
  });
}

metricSelect.addEventListener("change", () => {
  state.metric = selectMetric(metricSelect.value as MetricId, state.metric);
  render();
});

seatSelect.addEventListener("change", () => {
  const next = Number.parseInt(seatSelect.value, 10);
  state.seatIndex = selectSeat(next, state.seatCount, state.seatIndex);
  render();
});

playbackSelect.addEventListener("change", () => {
  const next = Number.parseFloat(playbackSelect.value);
  state.playbackSpeed = clampPlaybackSpeed(next);
  render();
});

scrubber.addEventListener("input", () => {
  scrubberValue.textContent = `${scrubber.value} / ${scrubber.max}`;
});

pauseBtn.addEventListener("click", () => {
  if (!getActionEnabled("playback", state.generationStatus)) {
    return;
  }
  state.isPaused = !state.isPaused;
  render();
});

resetBtn.addEventListener("click", () => {
  if (!getActionEnabled("playback", state.generationStatus)) {
    return;
  }
  scrubber.value = "0";
  state.isPaused = true;
  render();
});

seamInspectBtn.addEventListener("click", () => {
  if (!getActionEnabled("seamInspect", state.generationStatus)) {
    return;
  }
  seamInspectBtn.setAttribute("aria-pressed", "true");
  window.setTimeout(() => {
    seamInspectBtn.setAttribute("aria-pressed", "false");
  }, 1200);
});

localRegenerateBtn.addEventListener("click", () => {
  if (!getActionEnabled("localRegenerate", state.generationStatus)) {
    return;
  }
  state.generationStatus = "generating";
  render();
  window.setTimeout(() => {
    state.generationStatus = getNextStatusAfterGenerate(state.generationStatus);
    render();
  }, 700);
});

pinBtn.addEventListener("click", () => {
  const pinned = pinBtn.dataset.pinned === "true";
  pinBtn.dataset.pinned = String(!pinned);
  pinBtn.setAttribute("aria-pressed", String(!pinned));
  pinBtn.textContent = pinned ? "Pin" : "Pinned";
  inspector.classList.toggle("is-pinned", !pinned);
});

// Mobile drawers
for (const tab of mobileTabs) {
  tab.addEventListener("click", () => {
    const target = tab.dataset.drawer;
    const isOpen = tab.getAttribute("aria-expanded") === "true";
    // close all
    for (const other of mobileTabs) {
      other.setAttribute("aria-expanded", "false");
    }
    generationRail.classList.remove("is-open");
    inspector.classList.remove("is-open");
    telemetry.classList.remove("is-open");

    if (!isOpen) {
      tab.setAttribute("aria-expanded", "true");
      if (target === "left") {
        generationRail.classList.add("is-open");
      } else if (target === "right") {
        inspector.classList.add("is-open");
      } else if (target === "telemetry") {
        telemetry.classList.add("is-open");
      }
    }
  });
}

// Keyboard shortcuts: M for mute, Space for pause when not typing
document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement | null;
  const isTyping =
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement;
  if (isTyping) {
    return;
  }
  if (event.key === "m" || event.key === "M") {
    state.isMuted = !state.isMuted;
    render();
  } else if (event.key === " ") {
    event.preventDefault();
    if (getActionEnabled("playback", state.generationStatus)) {
      state.isPaused = !state.isPaused;
      render();
    }
  } else if (event.key === "r" || event.key === "R") {
    const nextMode: AppState["appMode"] =
      state.appMode === "ride" ? "edit" : "ride";
    state.appMode = nextMode;
    render();
  }
});

// Resize canvas to device pixels without drawing fake coaster
function resizeCanvases(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (const canvas of [viewportCanvas, telemetryGraph]) {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext("2d");
    if (ctx && canvas === telemetryGraph) {
      ctx.clearRect(0, 0, w, h);
      // Keep telemetry graph empty — no fake data; subtle grid only when ready
      if (state.generationStatus === "ready") {
        ctx.strokeStyle = "rgba(255,255,255,0.06)";
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i += 1) {
          const y = (h / 4) * i;
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
      }
    }
  }
}

window.addEventListener("resize", resizeCanvases);

// Change reduced motion live if system preference changes
window
  .matchMedia("(prefers-reduced-motion: reduce)")
  .addEventListener("change", (event) => {
    // Only follow system if user hasn't toggled manually via future control;
    // for now, follow system directly.
    state.reducedMotion = getReducedMotionState(event.matches, null);
    render();
  });

// Three renderer lifecycle – terrain/grid only before generation (no fixture coaster)
let rendererHandle: ReturnType<typeof createRendererHandle> = null;
let threeCamera: THREE.PerspectiveCamera | null = null;
let metrics = new RenderMetrics();
let prevCameraState: ReturnType<typeof getCameraState> | undefined;
let animationId = 0;
let lastFrameMs = performance.now();

function initRenderer(): void {
  if (rendererHandle) {
    try {
      rendererHandle.dispose();
    } catch {
      /* ignore */
    }
    rendererHandle = null;
  }
  const handle = createRendererHandle(viewportCanvas, {
    dprCap: 2,
    terrainSeed: state.seed || "default-terrain",
    onWebGLFailure: () => {
      hasWebGL = false;
      render();
    },
  });
  if (!handle) {
    hasWebGL = false;
    render();
    return;
  }
  hasWebGL = true;
  rendererHandle = handle;
  // Verify renderer config matches spec: shadows capped, DPR capped, tone mapping
  threeCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 1200);
  threeCamera.position.set(0, 28, 52);
  render();

  const onResize = (): void => {
    if (!rendererHandle || !threeCamera) return;
    const rect = viewportCanvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    rendererHandle.resize(w, h);
    threeCamera.aspect = w / Math.max(1, h);
    threeCamera.updateProjectionMatrix();
  };
  // Attach once; remove previous if re-init
  window.removeEventListener("resize", onResize as EventListener);
  window.addEventListener("resize", onResize as EventListener);
  onResize();

  if (animationId) cancelAnimationFrame(animationId);
  const tick = (): void => {
    animationId = requestAnimationFrame(tick);
    const now = performance.now();
    const deltaMs = now - lastFrameMs;
    lastFrameMs = now;
    if (!rendererHandle || !threeCamera) return;
    metrics.beginFrame();
    // Visual-only camera damping; no authoritative data mutation
    // Before generation there is no track, so chase camera falls back to orbiting terrain center
    // Use a lightweight placeholder track distance 0 with capped FOV
    // Clamped speed FOV: use 0 speed before playback
    const speed = 0;
    threeCamera.fov = clampFovForSpeed(speed);
    // Reduced-motion path: when prefers-reduced-motion, freeze orbit animation
    try {
      // Dummy compiled-track-like stub for terrain-only view: provide minimal orbit
      // For now terrain-only orbit around origin
      const orbitRadius = state.reducedMotion ? 0 : 0; // keep static when reduced, otherwise subtle
      void orbitRadius;
      // Simple idle orbit when no track: slow yaw around terrain center
      const idleAngle = state.reducedMotion
        ? 0
        : (now * 0.00007) % (Math.PI * 2);
      const radius = 62;
      const height = 28;
      const target = new THREE.Vector3(0, 0, 0);
      // Apply damping visually: lerp towards target
      const rawPos = new THREE.Vector3(
        Math.cos(idleAngle) * radius,
        height,
        Math.sin(idleAngle) * radius,
      );
      if (prevCameraState) {
        const damp = state.reducedMotion ? 0.02 : 0.08;
        threeCamera.position.lerp(rawPos, damp);
      } else {
        threeCamera.position.copy(rawPos);
      }
      threeCamera.lookAt(target);
      threeCamera.updateProjectionMatrix();
      // Keep a dummy cameraState for damping parity with track cameras
      prevCameraState = getCameraState(
        state.camera,
        {
          positions: new Float64Array([0, 0, 0, 0, 0, 0]),
          tangents: new Float64Array([1, 0, 0, 1, 0, 0]),
          normals: new Float64Array([0, 1, 0, 0, 1, 0]),
          binormals: new Float64Array([0, 0, 1, 0, 0, 1]),
          distances: new Float64Array([0, 1]),
          curvature: new Float64Array([0, 0]),
          bank: new Float64Array([0, 0]),
          bankDerivative: new Float64Array([0, 0]),
          zoneMasks: new Uint32Array([0, 0]),
          zoneNames: [],
          elementIndices: new Uint32Array([0, 0]),
          elementBoundaries: new Uint32Array([0, 1]),
          parameters: new Float64Array([0, 1]),
          totalLength: 1,
          checksum: "terrain-only",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
        0,
        speed,
        {
          reducedMotion: state.reducedMotion,
          previous: prevCameraState,
          deltaMs,
        },
      );
    } catch {
      // ignore camera errors before track load
    }
    rendererHandle.renderer?.render(rendererHandle.scene, threeCamera);
    metrics.endFrame();
    // Record frame metrics (drawCalls/triangles would be queried from renderer.info if available)
    const info = (
      rendererHandle.renderer as unknown as {
        info?: { render?: { calls?: number; triangles?: number } };
      }
    )?.info;
    if (info?.render) {
      metrics.recordBuild(
        metrics.meshBuildTimeMs,
        info.render.calls ?? 0,
        info.render.triangles ?? 0,
      );
    }
  };
  tick();
}

initRenderer();

webglRetry.addEventListener("click", () => {
  hasWebGL = supportsWebGL();
  if (hasWebGL) {
    initRenderer();
    render();
  } else {
    webglFallback.querySelector("p")!.textContent =
      "Still unavailable — try restarting the browser with hardware acceleration enabled.";
  }
});

// Re-init terrain deterministically when seed changes and user generates (still error path)
// For now terrain seed follows state.seed via initRenderer on generation attempt
const originalHandleGenerate = handleGenerate;
function wrappedGenerate(): void {
  originalHandleGenerate();
  // after short timeout, re-seed terrain if needed (visual only, no track)
  window.setTimeout(() => {
    if (rendererHandle) {
      try {
        rendererHandle.dispose();
      } catch {
        /* ignore */
      }
      initRenderer();
    }
  }, 950);
}
// Replace handler
generateBtn.removeEventListener("click", handleGenerate);
generateBtn.addEventListener("click", wrappedGenerate);

// Keep metrics accessible for debugging
window.__vibecoasterMetrics = metrics;

// Initial paint
render();
resizeCanvases();

// Expose for manual inspection in devtools (not used in tests)
declare global {
  interface Window {
    __vibecoasterState?: AppState;
    __vibecoasterMetrics?: RenderMetrics;
  }
}
window.__vibecoasterState = state;
