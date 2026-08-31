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
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // Activate Directed via accessible label (radio is visually hidden, user cannot click hidden input directly)
    await page.locator("label:has(#generation-directed)").click();
    await expect(page.locator("#generation-directed")).toBeChecked();
    // Ensure required stall remains checked for directed generation
    const stall = page.locator("#required-stall");
    if (!(await stall.isChecked())) await stall.check();
    await expect(stall).toBeChecked();
    // Fill rectangle footprint via directed DOM controls (canonical order)
    await page.locator("#footprint-min-x").fill("-260");
    await page.locator("#footprint-max-x").fill("260");
    await page.locator("#footprint-min-z").fill("-180");
    await page.locator("#footprint-max-z").fill("180");
    await page.locator("#height-min").fill("0");
    await page.locator("#height-max").fill("100");
    await page.locator("#seed-input").click();
    await page.locator("#seed-input").fill("5555");
    await page.locator("#generate-btn").click();
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
    // Ensure polygon Vec3 order never emits AABB {min,max} object
    expect(JSON.stringify(payload.intent.footprint).includes('"min"')).toBe(
      false,
    );
    // Reload the just-downloaded file through #load-file to prove browser loader round-trip
    const reloadTmp = await fs.mkdtemp(path.join(os.tmpdir(), "reload-"));
    const reloadPath = path.join(reloadTmp, "reload.json");
    await fs.writeFile(reloadPath, bytes, "utf-8");
    await page.locator("#load-file").setInputFiles(reloadPath);
    await waitForReady(page);
    const reloadSnap = await page.evaluate(() => {
      const snap = window.__vibecoasterSnapshot?.();
      return snap
        ? {
            footprint: snap.intentFootprint,
            heightRange: snap.intentHeightRange,
          }
        : null;
    });
    if (!reloadSnap) throw new Error("reload snapshot missing");
    expect(reloadSnap.footprint).toEqual(snapshot.footprint);
    expect(reloadSnap.heightRange).toEqual(snapshot.heightRange);
    await fs.rm(reloadTmp, { recursive: true, force: true });
    expect(
      obs.consoleAll.filter((m) => m.type === "error" || m.type === "warning"),
    ).toEqual([]);
    assertNoObservability(obs, "polygon-directed-rectangle");
  });

  test("concave polygon order round-trip via file and browser snapshot", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // Generate base CoasterFile inside Chromium via insta (browser-authenticated, same-runtime)
    await page.locator("label:has(#generation-insta)").click();
    await expect(page.locator("#generation-insta")).toBeChecked();
    await page.locator("#seed-input").click();
    await page.locator("#seed-input").fill("42");
    await page.locator("#generate-btn").click();
    await waitForReady(page);
    // Save base file produced by Chromium engine and read its bytes in Playwright
    const baseDownloadPromise = page.waitForEvent("download");
    await page.locator("#save-btn").click();
    const baseDownload = await baseDownloadPromise;
    const basePath = await baseDownload.path();
    if (!basePath) throw new Error("base download missing");
    const baseBytes = await fs.readFile(basePath, "utf-8");
    const basePayload = JSON.parse(baseBytes) as Record<string, unknown>;
    // Mutate ONLY intent footprint/heightRange in Node, keep browser-produced solvedSpans/checksum untouched
    const concavePolygon: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 6],
      [6, 0, 6],
      [6, 0, 10],
      [0, 0, 10],
    ];
    const intent = basePayload.intent as Record<string, unknown>;
    intent.footprint = concavePolygon;
    intent.heightRange = { min: 0, max: 100 };
    const mutated = JSON.stringify(basePayload);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "concave-"));
    const tmpPath = path.join(tmp, "concave.json");
    await fs.writeFile(tmpPath, mutated, "utf-8");
    // Load mutated file back into SAME Chromium runtime
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

  test("gate inside concave AABB but outside notch flagged via browser snapshot contradiction with exact evidence", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // Browser-authenticated base generation via insta (same-runtime), then intent-only mutation for concave+gates
    await page.locator("label:has(#generation-insta)").click();
    await expect(page.locator("#generation-insta")).toBeChecked();
    await page.locator("#seed-input").click();
    await page.locator("#seed-input").fill("7");
    await page.locator("#generate-btn").click();
    await waitForReady(page);
    const baseDownloadPromise = page.waitForEvent("download");
    await page.locator("#save-btn").click();
    const baseDownload = await baseDownloadPromise;
    const basePath = await baseDownload.path();
    if (!basePath) throw new Error("base download missing");
    const baseBytes = await fs.readFile(basePath, "utf-8");
    const basePayload = JSON.parse(baseBytes) as Record<string, unknown>;
    const concavePolygon: [number, number, number][] = [
      [0, 0, 0],
      [10, 0, 0],
      [10, 0, 6],
      [6, 0, 6],
      [6, 0, 10],
      [0, 0, 10],
    ];
    const intent = basePayload.intent as Record<string, unknown>;
    intent.footprint = concavePolygon;
    intent.heightRange = { min: 0, max: 20 };
    intent.gates = [
      { id: "gate-000", position: [8, 12, 8] },
      { id: "gate-001", position: [6, 12, 6] },
    ];
    const mutated = JSON.stringify(basePayload);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "gate-"));
    const tmpPath = path.join(tmp, "gate.json");
    await fs.writeFile(tmpPath, mutated, "utf-8");
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
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // Mobile: generation rail is in a drawer, open it via accessible tab button before activating Directed
    const leftTab = page.locator('button[data-drawer="left"]');
    if (await leftTab.isVisible()) {
      await leftTab.click();
      await expect(page.locator("#generation-rail")).toBeVisible();
    }
    // Activate Directed via accessible label (radio input is visually hidden, never force hidden input click)
    await page.locator("label:has(#generation-directed)").click();
    await expect(page.locator("#generation-directed")).toBeChecked();
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
    // Reach gate checkbox via Tab navigation (no direct .focus() — keyboard reachability)
    let gateFocused = false;
    for (let i = 0; i < 40; i++) {
      const id = await page.evaluate(() => document.activeElement?.id ?? "");
      if (id === "gate-0-enabled") {
        gateFocused = true;
        break;
      }
      await page.keyboard.press("Tab");
    }
    expect(gateFocused).toBe(true);
    await expect(page.locator("#gate-0-enabled")).toBeFocused();
    await page.keyboard.press("Space");
    await expect(page.locator("#gate-0-enabled")).toBeChecked();
    expect(
      obs.consoleAll.filter((m) => m.type === "error" || m.type === "warning"),
    ).toEqual([]);
    assertNoObservability(obs, "polygon-keyboard");
  });
});
