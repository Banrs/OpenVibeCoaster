/// <reference lib="dom" />
import { expect, test } from "@playwright/test";
import { percentilePair, type BenchmarkSummary } from "./benchmark-helpers.js";

// Disable benchmark instrumentation that contends with measurement.
test.use({ trace: "off", screenshot: "off" });

// Real-browser benchmark acceptance contract.
// Owns only browser-observable stages via Performance API measures.
// Existing generator bench owns search/solving/compilation/validation and must remain untouched.

const VIEWPORT = { width: 1920, height: 1080 } as const;

// Future app contract – standard Performance API measure names (not window test hooks).
const MEASURE_SIMULATION = "ovc:simulation";
const MEASURE_WORKER_TRANSFER = "ovc:worker-transfer";
const MEASURE_MESH_CREATE = "ovc:mesh-create";
const MEASURE_FRAME = "ovc:frame";
const MEASURE_GENERATION_TOTAL = "ovc:generation-total";

const REQUIRED_MEASURES = [
  MEASURE_GENERATION_TOTAL,
  MEASURE_SIMULATION,
  MEASURE_WORKER_TRANSFER,
  MEASURE_MESH_CREATE,
  MEASURE_FRAME,
] as const;

const OPTIONAL_MEASURES: readonly string[] = [] as const;

// Deterministic distinct uint32 seeds.
const WARMUP_SEEDS: readonly number[] = [7, 42, 1337] as const;
const MEASURED_SEEDS: readonly number[] = Array.from(
  { length: 50 },
  (_, index) => 1000 + index,
);

const GENERATION_P95_TARGET_MS = 1000;
const FRAME_P95_TARGET_MS = 16.7;
const MIN_STEADY_FRAMES_TOTAL = 120;

test.describe("browser-benchmark – real-browser acceptance (chromium, 1080p)", () => {
  test("warm up 3 seeds then 50 measured seeds via UI at 1080p, Performance API only, p50/p95", async ({
    page,
  }) => {
    // Scoped realistic timeout: observed complete per-seed browser generation 52.7-63.6s
    // for each of 53 sequential UI generations (3 warmup + 50 measured)
    // → 53 × 52.7-63.6s ≈ 2793-3371s, plus per-seed generation/simulation/mesh clears,
    // 90s status wait, 8s frame wait (30 steady frames at 1080p), and preview
    // build overhead. 3_600_000 ms (60 min) was observed insufficient (browser benchmark failed at 1.0h);
    // 5_400_000 ms (90 min) is the measurement budget without touching global Playwright config.
    test.setTimeout(5_400_000);

    await page.setViewportSize({
      width: VIEWPORT.width,
      height: VIEWPORT.height,
    });

    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const fetchXhrRequests: string[] = [];
    const crossOriginRequests: string[] = [];
    let pageOrigin = "";

    page.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(message.text());
      }
    });
    page.on("pageerror", (error) => {
      pageErrors.push(error.message);
    });
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("blob:")) {
        return;
      }
      const resourceType = request.resourceType();
      if (resourceType === "fetch" || resourceType === "xhr") {
        // Fail for any fetch/XHR – including same-origin – because benchmark must be self-contained without network latency variance.
        // Same-origin build assets are document/script/stylesheet, not fetch/xhr, so they are excluded here.
        fetchXhrRequests.push(`${resourceType}:${url}`);
      }
      // Cross-origin: any https?/wss? whose origin differs from the navigated preview origin.
      // Same-origin build assets (same origin as page URL) are not cross-origin.
      try {
        const parsed = new URL(url);
        const originToCompare = pageOrigin || "";
        if (
          (parsed.protocol === "http:" ||
            parsed.protocol === "https:" ||
            parsed.protocol === "wss:" ||
            parsed.protocol === "ws:") &&
          originToCompare &&
          parsed.origin !== originToCompare
        ) {
          crossOriginRequests.push(url);
        }
      } catch {
        // ignore non-URL requests like data:
      }
    });

    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    try {
      pageOrigin = new URL(page.url()).origin;
    } catch {
      pageOrigin = "";
    }

    // Helpers to interact only via named Performance API measures – no fixtures/route/fetch/sleeps/window.__test*/synthetic arrays/product imports.
    async function clearNamedMeasures(): Promise<void> {
      const names = [...REQUIRED_MEASURES, ...OPTIONAL_MEASURES];
      await page.evaluate((measureNames: string[]) => {
        for (const name of measureNames) {
          try {
            performance.clearMeasures(name);
          } catch {
            // ignore missing
          }
        }
      }, names);
    }

    async function clearFrameMeasuresOnly(): Promise<void> {
      await page.evaluate((frameName: string) => {
        try {
          performance.clearMeasures(frameName);
        } catch {
          // ignore missing
        }
      }, MEASURE_FRAME);
    }

    async function getMeasureDurations(): Promise<Record<string, number[]>> {
      return await page.evaluate(
        (measureNames: string[]) => {
          const entries = performance.getEntriesByType(
            "measure",
          ) as PerformanceMeasure[];
          const out: Record<string, number[]> = {};
          for (const name of measureNames) {
            out[name] = [];
          }
          for (const entry of entries) {
            if ((measureNames as string[]).includes(entry.name)) {
              out[entry.name]?.push(entry.duration);
            }
          }
          return out;
        },
        [...REQUIRED_MEASURES, ...OPTIONAL_MEASURES],
      );
    }

    async function getReadyStateAndReadouts(): Promise<{
      generationStatus: string;
      statusText: string;
      lengthM: string;
      checksum: string;
      lengthNum: number | null;
    }> {
      return await page.evaluate(() => {
        const statusEl = document.getElementById(
          "status",
        ) as HTMLElement | null;
        const lengthEl = document.querySelector(
          '[data-testid="track-length"]',
        ) as HTMLElement | null;
        const checksumEl = document.querySelector(
          '[data-testid="compiled-checksum"]',
        ) as HTMLElement | null;
        const gen = statusEl?.dataset.state ?? "";
        const txt =
          statusEl?.querySelector(".status-text")?.textContent?.trim() ?? "";
        const lengthM = lengthEl?.getAttribute("data-length-m") ?? "";
        const checksum = checksumEl?.getAttribute("data-checksum") ?? "";
        const parsed = lengthM ? Number.parseFloat(lengthM) : NaN;
        return {
          generationStatus: gen,
          statusText: txt,
          lengthM,
          checksum,
          lengthNum: Number.isFinite(parsed) ? parsed : null,
        };
      });
    }

    async function runOneSeed(seed: number): Promise<{
      simulationMs: number;
      workerTransferMs: number;
      meshCreateMs: number;
      generationTotalMs: number;
      frameDurations: number[];
      lengthNum: number;
      checksum: string;
    }> {
      await clearNamedMeasures();

      // Real UI path only – fill seed, click generate, wait for ready status (not via window test hook).
      const seedInput = page.locator("#seed-input");
      const generateBtn = page.locator("#generate-btn");
      await expect(seedInput).toBeVisible();
      await expect(generateBtn).toBeVisible();
      await seedInput.fill(String(seed));
      await generateBtn.click();

      // Wait for the generating -> terminal transition without sleeping.
      // The unwired app will go generating -> error; real app will go generating -> ready.
      // We wait for status dataset to leave generating, then assert ready.
      await page.waitForFunction(
        () => {
          const el = document.getElementById("status") as HTMLElement | null;
          const state = el?.dataset.state ?? "";
          return state !== "generating" && state !== "";
        },
        null,
        { timeout: 90_000 },
      );

      const state = await getReadyStateAndReadouts();

      // Require actual ready result – fail RED if error/pending so runs cannot benchmark an empty view.
      expect(
        state.generationStatus,
        `seed ${seed}: generationStatus must be ready, got "${state.generationStatus}" statusText="${state.statusText}"`,
      ).toBe("ready");

      // Require data-length-m 1600–2200 and real checksum.
      expect(
        state.lengthNum,
        `seed ${seed}: data-length-m must be finite, got "${state.lengthM}"`,
      ).not.toBeNull();
      expect(
        state.lengthNum as number,
        `seed ${seed}: data-length-m ${state.lengthNum} must be 1600–2200`,
      ).toBeGreaterThanOrEqual(1600);
      expect(
        state.lengthNum as number,
        `seed ${seed}: data-length-m ${state.lengthNum} must be 1600–2200`,
      ).toBeLessThanOrEqual(2200);
      expect(
        state.checksum.trim(),
        `seed ${seed}: data-checksum must be non-empty real checksum`,
      ).not.toBe("");
      // Checksum sanity: non-trivial hex-ish length >=8.
      expect(
        state.checksum.trim().length,
        `seed ${seed}: checksum length must be plausible`,
      ).toBeGreaterThanOrEqual(8);

      // Isolate steady frames: loading frames that fired during generation must
      // not leak into the steady p95. After ready + flagship length/checksum
      // proof and immediately before waiting for 30 steady frames, clear only
      // ovc:frame so simulation/transfer/mesh measures remain for this run.
      await clearFrameMeasuresOnly();

      // Steady frames only after mesh is ready at 1080p.
      // Use actual ovc:frame measures, not rAF callback intervals in the test.
      // Wait until enough frame samples have accumulated (per-seed fallback) – across the full suite we require >=120 total.
      await page.waitForFunction(
        (frameName: string) => {
          const entries = performance.getEntriesByType(
            "measure",
          ) as PerformanceMeasure[];
          let count = 0;
          for (const e of entries) {
            if (e.name === frameName) count += 1;
          }
          return count >= 30;
        },
        MEASURE_FRAME,
        { timeout: 8_000 },
      );

      const measures = await getMeasureDurations();

      function requireOne(name: string): number {
        const values = measures[name] ?? [];
        expect(
          values.length,
          `seed ${seed}: required measure "${name}" missing – app must emit performance.measure("${name}") (cannot derive worker transfer from total latency)`,
        ).toBeGreaterThan(0);
        // If multiple samples, take the last for per-seed stages (generation/simulation/mesh) – but forbid pretending total is a stage.
        const duration = values[values.length - 1] as number;
        expect(
          Number.isFinite(duration),
          `seed ${seed}: measure "${name}" duration must be finite, got ${duration}`,
        ).toBe(true);
        expect(
          duration,
          `seed ${seed}: measure "${name}" duration must be >=0, got ${duration}`,
        ).toBeGreaterThanOrEqual(0);
        // Guard against fabricated synthetic timing (e.g., Date.now difference disguised as performance measure is still a measure, but ensure not NaN/Infinity).
        return duration;
      }

      const simulationMs = requireOne(MEASURE_SIMULATION);
      // Exact worker-transfer mark is required – fail RED rather than deriving from total.
      const workerTransferMs = requireOne(MEASURE_WORKER_TRANSFER);
      const meshCreateMs = requireOne(MEASURE_MESH_CREATE);
      const generationTotalMs = requireOne(MEASURE_GENERATION_TOTAL);
      const frameList = measures[MEASURE_FRAME] ?? [];
      expect(
        frameList.length,
        `seed ${seed}: ovc:frame measures missing – must use performance.measure("${MEASURE_FRAME}") not test rAF intervals`,
      ).toBeGreaterThan(0);
      for (const d of frameList) {
        expect(
          Number.isFinite(d),
          `seed ${seed}: frame duration not finite`,
        ).toBe(true);
        expect(
          d,
          `seed ${seed}: frame duration must be >=0`,
        ).toBeGreaterThanOrEqual(0);
      }

      // Do not pretend a duration is a stage it does not measure – explicitly forbid counting generationTotal as simulation etc.
      // Already enforced by requiring each named measure individually.

      return {
        simulationMs,
        workerTransferMs,
        meshCreateMs,
        generationTotalMs,
        frameDurations: frameList,
        lengthNum: state.lengthNum as number,
        checksum: state.checksum,
      };
    }

    // Warm-up at least three deterministic seeds – every warm-up seed must assert Ready and real readouts.
    for (const seed of WARMUP_SEEDS) {
      await clearNamedMeasures();
      const seedInput = page.locator("#seed-input");
      const generateBtn = page.locator("#generate-btn");
      await expect(seedInput).toBeVisible();
      await expect(generateBtn).toBeVisible();
      await seedInput.fill(String(seed));
      await generateBtn.click();
      await page.waitForFunction(
        () => {
          const el = document.getElementById("status") as HTMLElement | null;
          const state = el?.dataset.state ?? "";
          return state !== "generating" && state !== "";
        },
        null,
        { timeout: 90_000 },
      );
      const warmState = await getReadyStateAndReadouts();
      expect(
        warmState.generationStatus,
        `warmup seed ${seed}: generationStatus must be ready, got "${warmState.generationStatus}" statusText="${warmState.statusText}"`,
      ).toBe("ready");
      expect(
        warmState.lengthNum,
        `warmup seed ${seed}: data-length-m must be finite, got "${warmState.lengthM}"`,
      ).not.toBeNull();
      expect(warmState.lengthNum as number).toBeGreaterThanOrEqual(1600);
      expect(warmState.lengthNum as number).toBeLessThanOrEqual(2200);
      expect(warmState.checksum.trim()).not.toBe("");
      expect(warmState.checksum.trim().length).toBeGreaterThanOrEqual(8);
      // Warm-up must also emit mandatory ovc:generation-total and required browser stages – fail if absent.
      const warmMeasures = await getMeasureDurations();
      for (const name of REQUIRED_MEASURES) {
        const values = warmMeasures[name] ?? [];
        expect(
          values.length,
          `warmup seed ${seed}: required measure "${name}" missing`,
        ).toBeGreaterThan(0);
        const d = values[values.length - 1] as number;
        expect(Number.isFinite(d) && d >= 0).toBe(true);
      }
      // Clear to avoid warm-up measures leaking into measured window.
      await clearNamedMeasures();
    }

    // Measured window – 50 distinct uint32 seeds through real UI.
    const simulationSamples: number[] = [];
    const workerTransferSamples: number[] = [];
    const meshCreateSamples: number[] = [];
    const generationTotalSamples: number[] = [];
    const allFrameDurations: number[] = [];

    // Ensure uniqueness of measured seeds (deterministic).
    expect(
      new Set(MEASURED_SEEDS).size,
      "measured seeds must be 50 distinct",
    ).toBe(50);
    for (const s of MEASURED_SEEDS) {
      expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
    }

    for (const seed of MEASURED_SEEDS) {
      const result = await runOneSeed(seed);
      simulationSamples.push(result.simulationMs);
      workerTransferSamples.push(result.workerTransferMs);
      meshCreateSamples.push(result.meshCreateMs);
      generationTotalSamples.push(result.generationTotalMs);
      allFrameDurations.push(...result.frameDurations);
    }

    // Mandatory ovc:generation-total – every measured seed must have contributed one.
    expect(
      generationTotalSamples.length,
      `generationTotal samples must be 50, got ${generationTotalSamples.length}`,
    ).toBe(50);

    // Meaningful steady-frame percentile requires at least 120 frames total across measured run (actual ovc:frame measures).
    expect(
      allFrameDurations.length,
      `steady frames total ${allFrameDurations.length} must be >=${MIN_STEADY_FRAMES_TOTAL} (actual ovc:frame measures at 1080p)`,
    ).toBeGreaterThanOrEqual(MIN_STEADY_FRAMES_TOTAL);

    // Compute nearest-rank p50/p95 deterministically – all required stages mandatory.
    const simulationPct = percentilePair(simulationSamples);
    const workerTransferPct = percentilePair(workerTransferSamples);
    const meshCreatePct = percentilePair(meshCreateSamples);
    const framePct = percentilePair(allFrameDurations);
    const generationTotalPct = percentilePair(generationTotalSamples);

    // Generation p95 and frame p95 are reporting targets – report misses honestly, do not fail solely for a target miss.
    const generationP95Met = generationTotalPct.p95 < GENERATION_P95_TARGET_MS;
    const frameTargetMet = framePct.p95 < FRAME_P95_TARGET_MS;

    const summary: BenchmarkSummary = {
      viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
      warmupSeedCount: WARMUP_SEEDS.length,
      measuredSeedCount: MEASURED_SEEDS.length,
      counts: {
        generationTotal: generationTotalSamples.length,
        simulation: simulationSamples.length,
        workerTransfer: workerTransferSamples.length,
        meshCreate: meshCreateSamples.length,
        frame: allFrameDurations.length,
      },
      percentiles: {
        generationTotal: generationTotalPct,
        simulation: simulationPct,
        workerTransfer: workerTransferPct,
        meshCreate: meshCreatePct,
        frame: framePct,
      },
      targets: {
        generationP95TargetMs: GENERATION_P95_TARGET_MS,
        frameP95TargetMs: FRAME_P95_TARGET_MS,
        generationP95Met,
        frameP95Met: frameTargetMet,
      },
      steadyFrameTotal: allFrameDurations.length,
    };

    // Print one JSON summary to stdout deterministically.
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(summary, null, 2));

    // Prove zero console/page errors, zero fetch/XHR and zero cross-origin requests using existing helper semantics (do not count same-origin build assets).
    expect(
      pageErrors,
      `page errors must be zero, got ${JSON.stringify(pageErrors)}`,
    ).toEqual([]);
    expect(
      consoleErrors,
      `console errors must be zero, got ${JSON.stringify(consoleErrors)}`,
    ).toEqual([]);
    expect(
      fetchXhrRequests,
      `fetch/XHR requests must be zero, got ${JSON.stringify(fetchXhrRequests)}`,
    ).toEqual([]);
    expect(
      crossOriginRequests,
      `cross-origin requests must be zero, got ${JSON.stringify(crossOriginRequests)}`,
    ).toEqual([]);

    // Honest reporting of target misses – warn but do not fail solely for target miss.
    if (!generationP95Met) {
      // eslint-disable-next-line no-console
      console.warn(
        `generation p95 ${generationTotalPct.p95}ms exceeds target ${GENERATION_P95_TARGET_MS}ms – reporting only`,
      );
    }
    if (!frameTargetMet) {
      // eslint-disable-next-line no-console
      console.warn(
        `frame p95 ${framePct.p95}ms exceeds target ${FRAME_P95_TARGET_MS}ms – reporting only`,
      );
    }

    // Fail for missing/invalid/fabricated stage evidence already asserted above.
    // Additional guard: percentiles must be finite nonnegative.
    for (const [name, pct] of Object.entries(summary.percentiles)) {
      if (!pct) continue;
      expect(Number.isFinite(pct.p50) && pct.p50 >= 0).toBe(true);
      expect(Number.isFinite(pct.p95) && pct.p95 >= 0).toBe(true);
      expect(pct.p95, `${name} p95 must be >= p50`).toBeGreaterThanOrEqual(
        pct.p50,
      );
    }

    // Viewport assertion: steady frames were measured at 1080p.
    const viewportSize = page.viewportSize();
    expect(viewportSize?.width).toBe(VIEWPORT.width);
    expect(viewportSize?.height).toBe(VIEWPORT.height);
  });
});
