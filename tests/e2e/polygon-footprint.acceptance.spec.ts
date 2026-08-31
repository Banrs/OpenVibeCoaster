import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertNoObservability,
  attachObservability,
  waitForReady,
} from "./acceptance-helpers.js";

test.describe("polygon – save/load and directed concave", () => {
  test("directed rectangle saves canonical polygon Vec3 order and heightRange separate", async ({
    page,
  }) => {
    const obs = attachObservability(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const { createDesignIntentV1, vec3 } =
      await import("@openvibecoaster/core");
    const { generateCoaster } = await import("@openvibecoaster/generator");
    // Create a valid coaster via insta (no footprint) then attach rectangle polygon
    const baseIntent = createDesignIntentV1({
      generatorVersion: "test-polygon",
      seed: 1234,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      terrainProfileId: "rolling-highlands-v1",
      pinnedElementIds: [],
    });
    const base = generateCoaster(baseIntent, { name: "rect-base" });
    const rectPolygon = [
      vec3(-260, 0, -180),
      vec3(260, 0, -180),
      vec3(260, 0, 180),
      vec3(-260, 0, 180),
    ];
    const { createCoasterFileV1, serializeCoasterFileV1 } =
      await import("@openvibecoaster/core");
    const rectFile = createCoasterFileV1({
      name: base.file.name,
      intent: {
        ...base.file.intent,
        footprint: rectPolygon,
        heightRange: { min: 0, max: 100 },
      },
      solvedSpans: base.file.solvedSpans,
      seed: base.file.seed,
      generatorVersion: base.file.generatorVersion,
      profileVersion: base.file.profileVersion,
      researchSnapshotIds: base.file.researchSnapshotIds,
      compiledDataChecksum: base.file.compiledDataChecksum,
    });
    const serialized = serializeCoasterFileV1(rectFile);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rect-"));
    const tmpPath = path.join(tmp, "rect.json");
    await fs.writeFile(tmpPath, serialized, "utf-8");
    await page.locator("#load-file").setInputFiles(tmpPath);
    await waitForReady(page);
    const snapshot = await page.evaluate(() => {
      const snap = window.__vibecoasterSnapshot?.();
      return snap
        ? {
            footprint: snap.intentFootprint,
            heightRange: snap.intentHeightRange,
          }
        : null;
    });
    if (!snapshot) throw new Error("snapshot missing");
    expect(Array.isArray(snapshot.footprint)).toBe(true);
    if (!snapshot.footprint) throw new Error("footprint missing");
    expect(snapshot.footprint.length).toBe(4);
    expect(snapshot.footprint[0]).toEqual([-260, 0, -180]);
    expect(snapshot.footprint[1]).toEqual([260, 0, -180]);
    expect(snapshot.footprint[2]).toEqual([260, 0, 180]);
    expect(snapshot.footprint[3]).toEqual([-260, 0, 180]);
    for (const v of snapshot.footprint) {
      if (!Array.isArray(v)) throw new Error("vertex must be array");
      expect(v[1]).toBe(0);
    }
    if (!snapshot.heightRange) throw new Error("heightRange missing");
    expect(snapshot.heightRange.min).toBe(0);
    expect(snapshot.heightRange.max).toBe(100);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#save-btn").click();
    const download = await downloadPromise;
    const dlPath = await download.path();
    if (!dlPath) throw new Error("download missing");
    const bytes = await fs.readFile(dlPath, "utf-8");
    const payload = JSON.parse(bytes) as {
      intent: { footprint: unknown; heightRange: unknown };
      compiledDataChecksum: string;
    };
    const loadedIntent = payload.intent;
    expect(Array.isArray(loadedIntent.footprint)).toBe(true);
    if (!Array.isArray(loadedIntent.footprint))
      throw new Error("footprint not array");
    expect(loadedIntent.footprint.length).toBe(4);
    expect(loadedIntent.footprint[0]).toEqual([-260, 0, -180]);
    for (const v of loadedIntent.footprint) {
      if (!Array.isArray(v)) throw new Error("vertex must be array");
      expect(v[1]).toBe(0);
    }
    expect(loadedIntent.heightRange).toEqual({ min: 0, max: 100 });
    await fs.rm(tmp, { recursive: true, force: true });
    expect(
      obs.consoleAll.filter((m) => m.type === "error" || m.type === "warning"),
    ).toEqual([]);
    assertNoObservability(obs, "polygon-directed-rectangle");
  });

  test("concave polygon order round-trip via file and browser snapshot", async ({
    page,
  }) => {
    const obs = attachObservability(page);
    const { createDesignIntentV1, vec3 } =
      await import("@openvibecoaster/core");
    const { generateCoaster } = await import("@openvibecoaster/generator");
    const concavePolygon = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 6),
      vec3(6, 0, 6),
      vec3(6, 0, 10),
      vec3(0, 0, 10),
    ];
    const baseIntent = createDesignIntentV1({
      generatorVersion: "test-polygon",
      seed: 42,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      terrainProfileId: "rolling-highlands-v1",
      pinnedElementIds: [],
    });
    const base = generateCoaster(baseIntent, { name: "concave-base" });
    const { createCoasterFileV1, serializeCoasterFileV1 } =
      await import("@openvibecoaster/core");
    const concaveFile = createCoasterFileV1({
      name: base.file.name,
      intent: {
        ...base.file.intent,
        footprint: concavePolygon,
        heightRange: { min: 0, max: 100 },
      },
      solvedSpans: base.file.solvedSpans,
      seed: base.file.seed,
      generatorVersion: base.file.generatorVersion,
      profileVersion: base.file.profileVersion,
      researchSnapshotIds: base.file.researchSnapshotIds,
      compiledDataChecksum: base.file.compiledDataChecksum,
    });
    const serialized = serializeCoasterFileV1(concaveFile);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "concave-"));
    const tmpPath = path.join(tmp, "concave.json");
    await fs.writeFile(tmpPath, serialized, "utf-8");
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#load-file").setInputFiles(tmpPath);
    await waitForReady(page);
    const snapshot = await page.evaluate(() => {
      const snap = window.__vibecoasterSnapshot?.();
      return snap
        ? {
            footprint: snap.intentFootprint,
            heightRange: snap.intentHeightRange,
          }
        : null;
    });
    if (!snapshot) throw new Error("snapshot missing after concave load");
    expect(Array.isArray(snapshot.footprint)).toBe(true);
    if (!snapshot.footprint) throw new Error("footprint missing");
    expect(snapshot.footprint.length).toBe(6);
    expect(snapshot.footprint[0]).toEqual([0, 0, 0]);
    expect(snapshot.footprint[2]).toEqual([10, 0, 6]);
    for (const v of snapshot.footprint) {
      if (!Array.isArray(v)) throw new Error("vertex must be array");
      expect(v[1]).toBe(0);
    }
    if (!snapshot.heightRange) throw new Error("heightRange missing");
    expect(snapshot.heightRange.min).toBe(0);
    expect(snapshot.heightRange.max).toBe(100);
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#save-btn").click();
    const download = await downloadPromise;
    const dlPath = await download.path();
    if (!dlPath) throw new Error("download missing");
    const bytes = await fs.readFile(dlPath, "utf-8");
    const payload = JSON.parse(bytes) as {
      intent: { footprint: unknown; heightRange: unknown };
    };
    const loadedIntent = payload.intent;
    expect(Array.isArray(loadedIntent.footprint)).toBe(true);
    if (!Array.isArray(loadedIntent.footprint))
      throw new Error("footprint not array");
    expect(loadedIntent.footprint.length).toBe(6);
    expect(loadedIntent.footprint[0]).toEqual([0, 0, 0]);
    for (const v of loadedIntent.footprint) {
      if (!Array.isArray(v)) throw new Error("vertex must be array");
      expect(v[1]).toBe(0);
    }
    expect(loadedIntent.heightRange).toEqual({ min: 0, max: 100 });
    await fs.rm(tmp, { recursive: true, force: true });
    expect(
      obs.consoleAll.filter((m) => m.type === "error" || m.type === "warning"),
    ).toEqual([]);
    assertNoObservability(obs, "polygon-concave");
  });

  test("gate inside concave AABB but outside notch rejected in browser with exact evidence", async ({
    page,
  }) => {
    const obs = attachObservability(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const {
      createDesignIntentV1,
      vec3,
      createCoasterFileV1,
      serializeCoasterFileV1,
    } = await import("@openvibecoaster/core");
    const { generateCoaster } = await import("@openvibecoaster/generator");
    const concavePolygon = [
      vec3(0, 0, 0),
      vec3(10, 0, 0),
      vec3(10, 0, 6),
      vec3(6, 0, 6),
      vec3(6, 0, 10),
      vec3(0, 0, 10),
    ];
    const baseIntent = createDesignIntentV1({
      generatorVersion: "test-polygon",
      seed: 7,
      mode: "insta",
      family: "steel-sitdown-lsm-v1",
      elements: [],
      gates: [],
      targets: [],
      constraints: [],
      terrainProfileId: "rolling-highlands-v1",
      pinnedElementIds: [],
    });
    const base = generateCoaster(baseIntent, { name: "gate-base" });
    const gateFile = createCoasterFileV1({
      name: base.file.name,
      intent: {
        ...base.file.intent,
        footprint: concavePolygon,
        heightRange: { min: 0, max: 20 },
        gates: [
          { id: "gate-000", position: vec3(8, 12, 8) },
          { id: "gate-001", position: vec3(6, 12, 6) },
        ],
      },
      solvedSpans: base.file.solvedSpans,
      seed: base.file.seed,
      generatorVersion: base.file.generatorVersion,
      profileVersion: base.file.profileVersion,
      researchSnapshotIds: base.file.researchSnapshotIds,
      compiledDataChecksum: base.file.compiledDataChecksum,
    });
    const serialized = serializeCoasterFileV1(gateFile);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"));
    const tmpPath = path.join(tmp, "gate.json");
    await fs.writeFile(tmpPath, serialized, "utf-8");
    await page.locator("#load-file").setInputFiles(tmpPath);
    await waitForReady(page);
    const snapshot = await page.evaluate(() =>
      window.__vibecoasterSnapshot?.(),
    );
    if (!snapshot) throw new Error("snapshot missing");
    const diags = snapshot.gateContradictions;
    expect(Array.isArray(diags)).toBe(true);
    expect(diags.length).toBe(1);
    const diag = diags[0];
    if (!diag) throw new Error("diag missing");
    expect(diag.code).toBe("GATE_OUTSIDE_FOOTPRINT");
    expect(diag.provenance).toBe("PROJECT_ENGINEERING_LIMIT");
    if (
      diag.actual === undefined ||
      diag.limit === undefined ||
      diag.margin === undefined
    )
      throw new Error("evidence missing");
    expect(Number.isFinite(diag.actual)).toBe(true);
    expect(diag.actual).toBeGreaterThan(0);
    expect(diag.limit).toBe(0);
    expect(diag.margin).toBe(-diag.actual);
    expect(Number.isFinite(diag.margin)).toBe(true);
    expect(diag.message.includes("Gate 0")).toBe(true);
    const hasBoundary = diags.some((d) => d.message.includes("Gate 1"));
    expect(hasBoundary).toBe(false);
    await fs.rm(tmp, { recursive: true, force: true });
    expect(
      obs.consoleAll.filter((m) => m.type === "error" || m.type === "warning"),
    ).toEqual([]);
    assertNoObservability(obs, "polygon-notch");
  });

  test("directed rectangle controls remain keyboard reachable and not clipped", async ({
    page,
  }) => {
    const obs = attachObservability(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#generation-directed").click();
    await page.keyboard.press("Tab");
    let focusedId = "";
    for (let i = 0; i < 30; i++) {
      focusedId = await page.evaluate(() => document.activeElement?.id ?? "");
      if (
        focusedId === "footprint-min-x" ||
        focusedId === "footprint-max-x" ||
        focusedId === "footprint-min-z" ||
        focusedId === "footprint-max-z" ||
        focusedId === "height-min" ||
        focusedId === "height-max"
      )
        break;
      await page.keyboard.press("Tab");
    }
    expect([
      "footprint-min-x",
      "footprint-max-x",
      "footprint-min-z",
      "footprint-max-z",
      "height-min",
      "height-max",
    ]).toContain(focusedId);
    const overflow = await page.evaluate(() => {
      const activeId = document.activeElement?.id ?? "";
      const el = document.getElementById(activeId) as HTMLElement | null;
      if (!el) return { clipped: true, visible: false };
      const rect = el.getBoundingClientRect();
      const topBar = document.getElementById("top-bar");
      const topRect = topBar?.getBoundingClientRect();
      return {
        clipped: topRect ? rect.top < topRect.bottom : false,
        visible: rect.width > 0 && rect.height > 0,
      };
    });
    expect(overflow.visible).toBe(true);
    expect(overflow.clipped).toBe(false);
    await page.locator("#gate-0-enabled").focus();
    await expect(page.locator("#gate-0-enabled")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.locator("#gate-0-enabled")).toBeChecked();
    expect(
      obs.consoleAll.filter((m) => m.type === "error" || m.type === "warning"),
    ).toEqual([]);
    assertNoObservability(obs, "polygon-keyboard");
  });
});
