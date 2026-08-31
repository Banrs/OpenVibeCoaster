import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import {
  assertNoObservability,
  attachObservability,
  gotoAndGenerateInsta,
  noHorizontalOverflow,
  parseCoasterFileV1FromBytes,
  validateCoasterFileV1SchemaFields,
  waitForRAF,
  waitForReady,
} from "./acceptance-helpers.js";

test.describe("vertical-slice – insta generate to ride", () => {
  test("flow1: Insta -> ready diagnostics -> front-seat ride, 1.6-2.2km, 80m inverted top-hat, duration>5s, controls enabled", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#seed-input")).toHaveValue("1337");
    await page.locator("#generate-btn").click();
    await waitForReady(page);

    const errCount = await page
      .locator(
        '#diagnostics-list li[data-severity="error"], #diagnostics-list li[data-severity="fatal"]',
      )
      .count();
    expect(errCount, "no error/fatal diagnostics").toBe(0);
    await expect(page.locator("#diagnostics-list")).toBeVisible();

    const elementCount = await page.locator("#element-list li").count();
    expect(elementCount).toBeGreaterThan(5);
    expect(elementCount).toBeLessThan(20);

    const lengthEl = page.locator('[data-testid="track-length"]');
    await expect(lengthEl, "exact track-length readout").toBeVisible({
      timeout: 5_000,
    });
    const lengthRaw = await lengthEl.getAttribute("data-length-m");
    expect(
      lengthRaw,
      "data-length-m finite raw metres required",
    ).not.toBeNull();
    const lengthM = Number.parseFloat(lengthRaw!);
    expect(Number.isFinite(lengthM), "data-length-m must be finite").toBe(true);
    expect(lengthM).toBeGreaterThanOrEqual(1600);
    expect(lengthM).toBeLessThanOrEqual(2200);

    const elementTexts = await page
      .locator("#element-list li")
      .allTextContents();
    expect(
      elementTexts.some((t) => /tophat|top-hat/i.test(t)),
      `top-hat missing in ${elementTexts.join("|")}`,
    ).toBe(true);
    expect(
      elementTexts.some((t) => /inverted|180/i.test(t)),
      "inverted evidence missing",
    ).toBe(true);

    const durationEl = page.locator('[data-testid="timeline-duration"]');
    await expect(durationEl, "exact timeline-duration readout").toBeVisible({
      timeout: 5_000,
    });
    const durRaw = await durationEl.getAttribute("data-duration-s");
    const durText = durRaw ?? (await durationEl.textContent());
    const duration = durText ? Number.parseFloat(durText) : NaN;
    expect(duration).toBeGreaterThan(5);

    for (const id of [
      "#save-btn",
      "#export-btn",
      "#scrubber",
      "#pause-btn",
      "#reset-btn",
      "#playback-speed",
      "#metric-select",
      "#seat-select",
      "#local-regenerate-btn",
      "#seam-inspect-btn",
    ]) {
      await expect(page.locator(id)).toBeEnabled();
    }

    await page.locator('input[name="app-mode"][value="ride"]').click();
    await expect(page.locator("body")).toHaveClass(/mode-ride/);
    await page.locator('input[name="camera"][value="front"]').click();
    await expect(
      page.locator('input[name="camera"][value="front"]'),
    ).toBeChecked();
    await page.locator("#seat-select").selectOption("0");
    await expect(page.locator("#seat-select")).toHaveValue("0");
    await expect(page.locator("#viewport-canvas")).toBeVisible();

    assertNoObservability(obs, "flow1");
  });
});

test.describe("vertical-slice – ride controls", () => {
  test("flow2: cameras, pause/play, scrub, speeds, reset assert readout changes", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoAndGenerateInsta(page, "2026");

    for (const cam of ["front", "middle", "rear", "chase", "orbit"] as const) {
      await page.locator(`input[name="camera"][value="${cam}"]`).click();
      await expect(
        page.locator(`input[name="camera"][value="${cam}"]`),
      ).toBeChecked();
    }

    const pauseBtn = page.locator("#pause-btn");
    await expect(pauseBtn).toBeEnabled();
    const beforePressed = await pauseBtn.getAttribute("aria-pressed");
    const beforeText = await pauseBtn.textContent();
    await pauseBtn.click();
    expect(await pauseBtn.getAttribute("aria-pressed")).not.toBe(beforePressed);
    expect(await pauseBtn.textContent()).not.toBe(beforeText);
    await pauseBtn.click();
    expect(await pauseBtn.getAttribute("aria-pressed")).toBe(beforePressed);

    const scrubber = page.locator("#scrubber");
    const scrubValue = page.locator(".scrubber-value");
    await expect(scrubber).toBeEnabled();
    const startVal = await scrubber.inputValue();
    await scrubber.focus();
    await page.keyboard.press("ArrowRight");
    await scrubber.fill("500");
    expect(await scrubber.inputValue()).not.toBe(startVal);
    await expect(scrubValue).toContainText("500");
    await scrubber.fill("200");
    expect(await scrubber.inputValue()).toBe("200");

    const speed = page.locator("#playback-speed");
    for (const v of ["0.25", "0.5", "1", "2"] as const) {
      await speed.selectOption(v);
      await expect(speed).toHaveValue(v);
    }

    await page.locator("#reset-btn").click();
    await expect(scrubber).toHaveValue("0");
    await expect(scrubValue).toContainText("0 /");

    assertNoObservability(obs, "flow2");
  });
});

test.describe("vertical-slice – graph synchronization", () => {
  test("flow3: graph click -> scrubber, selection readout, highlight, playback position", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await gotoAndGenerateInsta(page, "42");

    const graph = page.locator("#telemetry-graph");
    await expect(graph).toBeVisible();
    const scrubber = page.locator("#scrubber");
    await expect(scrubber).toBeEnabled();
    const initialScrub = await scrubber.inputValue();
    const readout = page.locator("#selection-readout");
    const initialReadout = await readout.textContent();

    const box = await graph.boundingBox();
    expect(box).not.toBeNull();
    if (box)
      await page.mouse.click(
        box.x + box.width * 0.52,
        box.y + box.height * 0.5,
      );

    await expect
      .poll(async () => await scrubber.inputValue(), { timeout: 5_000 })
      .not.toBe(initialScrub);
    await expect
      .poll(async () => await readout.textContent(), { timeout: 5_000 })
      .not.toBe(initialReadout);
    expect(await readout.textContent()).toMatch(/(?:m|s|distance|time)/i);

    const highlight = page.locator('[data-testid="track-highlight"]');
    await expect(highlight.first(), "exact track-highlight").toBeVisible({
      timeout: 5_000,
    });
    const hd = await highlight.first().getAttribute("data-highlight-distance");
    expect(hd && Number.isFinite(Number.parseFloat(hd))).toBe(true);

    const trainPos = page.locator('[data-testid="train-position"]');
    await expect(trainPos.first(), "exact train-position").toBeVisible({
      timeout: 5_000,
    });

    assertNoObservability(obs, "flow3");
  });
});

test.describe("vertical-slice – metric coloring and seam", () => {
  test("flow4: color by G/speed/rollRate/clearance (+height/energy) and seam inspection bounded", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await gotoAndGenerateInsta(page, "99");

    const metric = page.locator("#metric-select");
    const legend = page.locator("#metric-legend");

    for (const m of [
      { value: "gForce", legend: "gForce" },
      { value: "speed", legend: "speed" },
      { value: "rollRate", legend: "rollRate" },
      { value: "clearance", legend: "clearance" },
      { value: "height", legend: "height" },
      { value: "energy", legend: "energy" },
    ] as const) {
      await metric.selectOption(m.value);
      await expect(metric).toHaveValue(m.value);
      const item = legend.locator(`[data-metric="${m.legend}"]`);
      await expect(item, `legend ${m.legend} exists`).toBeVisible();
      const selected = await item.evaluate(
        (el) =>
          el.classList.contains("is-selected") ||
          el.getAttribute("aria-selected") === "true" ||
          el.getAttribute("data-selected") === "true",
      );
      expect(selected, `legend ${m.legend} selected class/aria`).toBe(true);
    }

    const seamBtn = page.locator("#seam-inspect-btn");
    await expect(seamBtn).toBeEnabled();
    await seamBtn.click();
    await expect(seamBtn).toHaveAttribute("aria-pressed", "true", {
      timeout: 5_000,
    });

    const seam = page.locator('[data-testid="seam-boundaries"]');
    await expect(seam.first(), "exact seam-boundaries element").toBeVisible({
      timeout: 5_000,
    });
    const countAttr = await seam.first().getAttribute("data-count");
    const countText = countAttr ?? (await seam.first().textContent());
    const count = countText
      ? Number.parseInt(countText.replace(/[^0-9]/g, ""), 10)
      : NaN;
    expect(count).toBeGreaterThan(2);
    expect(count).toBeLessThan(20);

    await seamBtn.click();
    await expect(seamBtn).toHaveAttribute("aria-pressed", "false", {
      timeout: 3_000,
    });

    assertNoObservability(obs, "flow4");
  });
});

test.describe("vertical-slice – stable elements and local regenerate", () => {
  test("flow5: select/pin, edit param, local regenerate, unaffected hashes identical", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const obs = attachObservability(page);
    await gotoAndGenerateInsta(page, "777");

    const first = page.locator("#element-list li").first();
    await expect(first).toBeVisible();
    const elId = await first.getAttribute("data-element-id");
    expect(elId, "exact data-element-id required").toBeTruthy();
    expect((await first.getAttribute("data-span-hash")) ?? "").toMatch(
      /^[0-9a-f]{8}$/i,
    );
    await first.click();
    await expect(page.locator("#selection-readout")).not.toContainText(
      "No selection",
    );

    const hashesBefore = await page.evaluate(() => {
      const map: Record<string, string> = {};
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-element-id][data-span-hash]",
        ),
      )) {
        const id = el.getAttribute("data-element-id")!;
        const hash = el.getAttribute("data-span-hash")!;
        if (id && hash) map[id] = hash.trim();
      }
      return map;
    });
    expect(Object.keys(hashesBefore).length).toBeGreaterThan(2);
    for (const h of Object.values(hashesBefore))
      expect(h).toMatch(/^[0-9a-f]{8}$/i);

    const pinBtn = page.locator("#pin-btn");
    await pinBtn.click();
    await expect(pinBtn).toHaveAttribute("aria-pressed", "true");

    const lenInput = page.locator("#inspect-length");
    await expect(lenInput).toBeEnabled();
    const newLen = (
      Number.parseFloat(await lenInput.inputValue()) + 5
    ).toString();
    await lenInput.fill(newLen);
    await expect(lenInput).toHaveValue(newLen);

    await page.locator("#local-regenerate-btn").click();
    await waitForReady(page, 90_000);

    if (elId)
      await expect(
        page.locator(`#element-list li[data-element-id="${elId}"]`).first(),
      ).toBeVisible();

    const hashesAfter = await page.evaluate(() => {
      const map: Record<string, string> = {};
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-element-id][data-span-hash]",
        ),
      )) {
        const id = el.getAttribute("data-element-id")!;
        const hash = el.getAttribute("data-span-hash")!;
        if (id && hash) map[id] = hash.trim();
      }
      return map;
    });
    if (elId) {
      expect(
        hashesAfter[elId],
        "selected edited element hash should change after deliberate pinned override",
      ).not.toBe(hashesBefore[elId]);
    }
    let identical = 0;
    for (const k of Object.keys(hashesBefore))
      if (hashesAfter[k] === hashesBefore[k]) identical += 1;
    expect(identical, "nonempty unaffected hashes identical").toBeGreaterThan(
      0,
    );
    expect(Object.keys(hashesAfter).length).toBeGreaterThan(3);
    await expect(pinBtn).toHaveAttribute("aria-pressed", "true");

    assertNoObservability(obs, "flow5");
  });
});

test.describe("vertical-slice – directed generation", () => {
  test("flow6a: directed success – stall, gate, rect footprint, rolling terrain, hard+soft targets", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#generation-directed").click();
    await expect(page.locator("#generation-directed")).toBeChecked();

    const stall = page.locator("#required-stall");
    if (!(await stall.isChecked())) await stall.check();
    await expect(stall).toBeChecked();

    await page.locator("#gate-0-enabled").check();
    await expect(page.locator("#gate-0-enabled")).toBeChecked();
    await page.locator("#gate-0-x").fill("40");
    await page.locator("#gate-0-y").fill("12");
    await page.locator("#gate-0-z").fill("20");
    await page.locator("#gate-0-yaw").fill("5");
    await page.locator("#gate-0-pitch").fill("0");

    await page.locator("#footprint-min-x").fill("-260");
    await page.locator("#footprint-max-x").fill("260");
    await page.locator("#footprint-min-z").fill("-180");
    await page.locator("#footprint-max-z").fill("180");
    await page.locator("#height-min").fill("0");
    await page.locator("#height-max").fill("100");

    await expect(
      page.locator('#terrain-profile option[value="rolling-highlands-v1"]'),
    ).toHaveCount(1);
    await page.locator("#terrain-profile").selectOption("rolling-highlands-v1");
    await expect(page.locator("#terrain-profile")).toHaveValue(
      "rolling-highlands-v1",
    );

    await page.locator("#target-total-length-value").fill("1800");
    await page.locator("#target-total-length-class").selectOption("hard");
    await page.locator("#target-end-y-value").fill("18");
    await page.locator("#target-end-y-class").selectOption("soft");

    await page.locator("#seed-input").click();
    await page.locator("#seed-input").fill("1234");
    await page.locator("#generate-btn").click();
    await waitForReady(page, 90_000);

    expect(
      await page
        .locator(
          '#diagnostics-list li[data-severity="error"], #diagnostics-list li[data-severity="fatal"]',
        )
        .count(),
    ).toBe(0);
    const relaxCount = await page.locator("#relaxations-list li").count();
    expect(relaxCount).toBe(0);

    assertNoObservability(obs, "flow6a");
  });

  test("flow6b: directed infeasible – blocking terrain stays error, error diagnostic with provenance/location/margin, 0-3 tested relaxations", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.locator("#generation-directed").click();

    await page.locator("#required-stall").check();
    await page.locator("#gate-0-enabled").check();
    await page.locator("#gate-0-x").fill("500");
    await page.locator("#gate-0-y").fill("200");
    await page.locator("#gate-0-z").fill("500");

    await page.locator("#footprint-min-x").fill("-10");
    await page.locator("#footprint-max-x").fill("10");
    await page.locator("#footprint-min-z").fill("-10");
    await page.locator("#footprint-max-z").fill("10");
    await page.locator("#height-min").fill("80");
    await page.locator("#height-max").fill("85");

    await expect(
      page.locator('#terrain-profile option[value="blocking-canyon-v1"]'),
    ).toHaveCount(1);
    await page.locator("#terrain-profile").selectOption("blocking-canyon-v1");

    await page.locator("#target-total-length-value").fill("5000");
    await page.locator("#target-total-length-class").selectOption("hard");
    await page.locator("#target-end-y-value").fill("120");
    await page.locator("#target-end-y-class").selectOption("hard");

    await page.locator("#seed-input").click();
    await page.locator("#seed-input").fill("9999");
    await page.locator("#generate-btn").click();

    const status = page.locator("#status");
    await expect(status).not.toHaveAttribute("data-state", "ready", {
      timeout: 30_000,
    });
    await expect(status).toHaveAttribute("data-state", "error", {
      timeout: 10_000,
    });

    const errors = page.locator(
      '#diagnostics-list li[data-severity="error"], #diagnostics-list li[data-severity="fatal"]',
    );
    await expect(errors.first()).toBeVisible({ timeout: 10_000 });
    const n = await errors.count();
    expect(n).toBeGreaterThan(0);
    const first = errors.first();
    const code = await first.getAttribute("data-code");
    expect(code && code.length > 0, "error diagnostic must have code").toBe(
      true,
    );
    const prov = await first.getAttribute("data-provenance");
    expect(
      prov &&
        /PROJECT_ENGINEERING_LIMIT|SOURCE_VERIFIED|DESIGN_ASSUMPTION|UNKNOWN_UNCONFIGURED/.test(
          prov,
        ),
    ).toBe(true);
    // evidence checks where applicable – at least one of location/margin/actual/limit should be present and finite if present
    const loc = await first.getAttribute("data-location-s").catch(() => null);
    const margin = await first.getAttribute("data-margin").catch(() => null);
    const actual = await first.getAttribute("data-actual").catch(() => null);
    const limit = await first.getAttribute("data-limit").catch(() => null);
    const hasEvidence = [loc, margin, actual, limit].some(
      (v) => v !== null && Number.isFinite(Number.parseFloat(v!)),
    );
    expect(
      hasEvidence,
      "error diagnostic should carry finite location/margin/actual/limit evidence where applicable",
    ).toBe(true);

    const relaxations = page.locator("#relaxations-list li");
    const rCount = await relaxations.count();
    expect(rCount).toBeLessThanOrEqual(3);
    for (let i = 0; i < rCount; i++) {
      const li = relaxations.nth(i);
      const text = (await li.textContent()) ?? "";
      const hasLabel =
        /tested|suggested/i.test(text) ||
        (await li.getAttribute("data-tested")) !== null ||
        (await li.getAttribute("data-suggested")) !== null;
      expect(
        hasLabel,
        `relaxation ${i} must be labelled tested/suggested`,
      ).toBe(true);
      expect(
        /applied/i.test(text),
        `relaxation ${i} must not claim applied`,
      ).toBe(false);
    }

    assertNoObservability(obs, "flow6b");
  });
});

test.describe("vertical-slice – persistence", () => {
  test("flow7: save CoasterFileV1, load via file input, checksum/geometry/IDs/telemetry exact, schema+seed in Node", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const obs = attachObservability(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await gotoAndGenerateInsta(page, "5555");

    const preLengthEl = page.locator('[data-testid="track-length"]');
    await expect(preLengthEl).toBeVisible();
    const preLengthRaw = await preLengthEl.getAttribute("data-length-m");
    expect(
      preLengthRaw,
      "data-length-m finite raw metres required",
    ).not.toBeNull();
    const preLength = Number.parseFloat(preLengthRaw!);
    expect(Number.isFinite(preLength)).toBe(true);
    const preDurEl = page.locator('[data-testid="timeline-duration"]');
    await expect(preDurEl).toBeVisible();
    const preDurRaw = await preDurEl.getAttribute("data-duration-s");
    expect(preDurRaw, "data-duration-s required").not.toBeNull();
    const preDuration = Number.parseFloat(preDurRaw!);
    expect(Number.isFinite(preDuration)).toBe(true);
    const preChecksumEl = page.locator('[data-testid="compiled-checksum"]');
    await expect(preChecksumEl).toBeVisible();
    const preChecksum =
      (await preChecksumEl.getAttribute("data-checksum")) ??
      (await preChecksumEl.textContent()) ??
      "";
    expect(preChecksum).toMatch(/^[0-9a-f]{8}$/i);
    const preIds = await page
      .locator("#element-list li[data-element-id]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-element-id")!));
    expect(preIds.length).toBeGreaterThan(5);
    const preTelemetry = await page
      .locator('[data-testid="telemetry-signature"]')
      .getAttribute("data-signature");
    expect(preTelemetry, "data-signature required").not.toBeNull();
    expect(preTelemetry!).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-\d+-\d+\.\d{2}$/i);

    const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.locator("#save-btn").click();
    const download = await downloadPromise;
    const dlPath = await download.path();
    expect(dlPath).not.toBeNull();
    const bytes = await fs.readFile(dlPath as string, "utf-8");

    const payload = parseCoasterFileV1FromBytes(bytes);
    const schemaErrors = validateCoasterFileV1SchemaFields(payload);
    expect(
      schemaErrors,
      `schema v1 errors: ${schemaErrors.join(";")} ${bytes.slice(0, 400)}`,
    ).toEqual([]);
    const json = payload as Record<string, unknown>;
    expect(typeof json.seed).toBe("number");
    expect((json as { seed: number }).seed).toBe(5555);
    const dlChecksum = (json.compiledDataChecksum as string) ?? "";
    expect(dlChecksum).toMatch(/^[0-9a-f]{8}$/i);
    expect(dlChecksum.toLowerCase()).toBe(preChecksum.toLowerCase());
    // Polygon footprint: save preserves order and never emits {min,max} AABB; heightRange separate
    const intent = (json as { intent: Record<string, unknown> }).intent;
    if (intent.footprint !== undefined) {
      expect(Array.isArray(intent.footprint)).toBe(true);
      const fp = intent.footprint as unknown[];
      expect(fp.length).toBeGreaterThan(0);
      // First vertex should be Vec3 with Y=0
      const first = fp[0] as number[];
      expect(Array.isArray(first)).toBe(true);
      expect(first[1]).toBe(0);
      // Never emits AABB object
      expect(JSON.stringify(intent.footprint)).not.toContain('"min"');
      expect(JSON.stringify(intent.footprint)).not.toContain('"max"');
      if (intent.heightRange !== undefined) {
        const hr = intent.heightRange as Record<string, unknown>;
        expect(typeof hr.min).toBe("number");
        expect(typeof hr.max).toBe("number");
      }
    }

    await page.locator("#load-file").setInputFiles(dlPath as string);
    await waitForReady(page, 90_000);

    const postChecksum =
      (await page
        .locator('[data-testid="compiled-checksum"]')
        .getAttribute("data-checksum")
        .catch(() => null)) ?? "";
    expect(postChecksum.toLowerCase()).toBe(preChecksum.toLowerCase());

    const postLengthRaw = await page
      .locator('[data-testid="track-length"]')
      .getAttribute("data-length-m");
    expect(postLengthRaw, "data-length-m after reload required").not.toBeNull();
    const postLength = Number.parseFloat(postLengthRaw!);
    expect(Number.isFinite(postLength)).toBe(true);
    expect(postLength).toBeCloseTo(preLength, 1);

    const postDurRaw = await page
      .locator('[data-testid="timeline-duration"]')
      .getAttribute("data-duration-s");
    expect(postDurRaw, "data-duration-s after reload required").not.toBeNull();
    const postDur = Number.parseFloat(postDurRaw!);
    expect(Number.isFinite(postDur)).toBe(true);
    expect(postDur).toBeCloseTo(preDuration, 1);

    const postIds = await page
      .locator("#element-list li[data-element-id]")
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-element-id")!));
    expect(postIds).toEqual(preIds);

    const postTelemetry = await page
      .locator('[data-testid="telemetry-signature"]')
      .getAttribute("data-signature");
    expect(
      postTelemetry,
      "data-signature after reload required",
    ).not.toBeNull();
    expect(postTelemetry!).toMatch(/^[0-9a-f]{8}-[0-9a-f]{8}-\d+-\d+\.\d{2}$/i);
    expect(postTelemetry).toBe(preTelemetry);

    assertNoObservability(obs, "flow7");
  });
});

test.describe("vertical-slice – keyboard, reduced motion, audio, viewports, no fetch", () => {
  test("flow8: keyboard generate/ride, reducedMotion, audio unlock/mute, viewports screenshots, no cross-origin/fetch", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const obs = attachObservability(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    await expect(page.locator("body")).toHaveClass(/reduced-motion/);
    const animDisabled = await page.evaluate(() => {
      const s = document.querySelector<HTMLElement>(".btn");
      const cs = s ? getComputedStyle(s) : null;
      const d = cs?.animationDuration ?? "";
      const t = cs?.transitionDuration ?? "";
      const isDisabled = (v: string) =>
        v === "0s" || v === "0.01ms" || v === "0ms" || parseFloat(v) <= 0.02;
      return isDisabled(d) && isDisabled(t);
    });
    expect(animDisabled).toBe(true);

    await page.keyboard.press("Tab");
    for (let i = 0; i < 10; i++) {
      if (
        await page.evaluate(() => document.activeElement?.id === "seed-input")
      )
        break;
      await page.keyboard.press("Tab");
    }
    await expect(page.locator("#seed-input")).toBeFocused();
    await page.keyboard.type(" 31415");
    let atGenerate = false;
    for (let i = 0; i < 15; i++) {
      if (
        (await page.evaluate(() => document.activeElement?.id)) ===
        "generate-btn"
      ) {
        atGenerate = true;
        break;
      }
      await page.keyboard.press("Tab");
    }
    expect(atGenerate).toBe(true);
    await page.keyboard.press("Enter");
    await waitForReady(page, 90_000);

    // Keyboard element selection: focus first element button and activate via keyboard
    const firstElementBtn = page.locator("#element-list li button").first();
    await expect(
      firstElementBtn,
      "element button keyboard-operable",
    ).toBeVisible();
    await firstElementBtn.focus();
    await expect(firstElementBtn).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#selection-readout")).not.toContainText(
      "No selection",
    );
    const firstElementId = await page
      .locator("#element-list li")
      .first()
      .getAttribute("data-element-id");
    expect(firstElementId, "exact first data-element-id required").toBeTruthy();
    await expect(page.locator("#selection-readout")).toContainText(
      firstElementId!,
    );

    // Second element via Space — must move selection to that exact data-element-id and not trigger global playback toggle
    const secondLi = page.locator("#element-list li").nth(1);
    await expect(secondLi, "second element li required").toBeVisible();
    const secondElementId = await secondLi.getAttribute("data-element-id");
    expect(
      secondElementId,
      "exact second data-element-id required",
    ).toBeTruthy();
    expect(secondElementId).not.toBe(firstElementId);
    const secondElementBtn = secondLi.locator("button");
    await expect(
      secondElementBtn,
      "second element button keyboard-operable",
    ).toBeVisible();
    await secondElementBtn.focus();
    await expect(secondElementBtn).toBeFocused();
    const pauseBtnForSpace = page.locator("#pause-btn");
    await expect(pauseBtnForSpace).toHaveText("Play");
    await expect(pauseBtnForSpace).toHaveAttribute("aria-pressed", "false");
    await page.keyboard.press("Space");
    await expect(page.locator("#selection-readout")).toContainText(
      secondElementId!,
    );
    await expect(pauseBtnForSpace).toHaveText("Play");
    await expect(pauseBtnForSpace).toHaveAttribute("aria-pressed", "false");

    // Keyboard telemetry scrubbing: ArrowRight/Home/End on focused telemetry graph
    const graph = page.locator("#telemetry-graph");
    await expect(graph).toBeVisible();
    await expect(graph).toHaveAttribute("role", "slider");
    await graph.focus();
    await expect(graph).toBeFocused();
    const initialVal = await graph.getAttribute("aria-valuenow");
    await page.keyboard.press("ArrowRight");
    await expect
      .poll(async () => await graph.getAttribute("aria-valuenow"), {
        timeout: 5_000,
      })
      .not.toBe(initialVal);
    await page.keyboard.press("Home");
    await expect(graph).toHaveAttribute("aria-valuenow", "0");
    const maxVal = await graph.getAttribute("aria-valuemax");
    expect(maxVal && Number.isFinite(Number.parseInt(maxVal, 10))).toBe(true);
    await page.keyboard.press("End");
    await expect(graph).toHaveAttribute("aria-valuenow", maxVal!);
    // Verify scrubber/highlight updated via keyboard telemetry
    await expect(page.locator("#scrubber")).toHaveValue("1000");

    await page.locator('input[name="app-mode"][value="ride"]').focus();
    await page.keyboard.press("Space");
    await expect(
      page.locator('input[name="app-mode"][value="ride"]'),
    ).toBeChecked();
    await page.locator('input[name="camera"][value="front"]').focus();
    await page.keyboard.press("Space");
    await expect(
      page.locator('input[name="camera"][value="front"]'),
    ).toBeChecked();

    const unlockBtn = page.locator("#audio-unlock-btn");
    await unlockBtn.click();
    const muteBtn = page.locator("#mute-btn");
    const before = await muteBtn.getAttribute("aria-pressed");
    await muteBtn.click();
    expect(await muteBtn.getAttribute("aria-pressed")).not.toBe(before);
    await muteBtn.click();
    expect(await muteBtn.getAttribute("aria-pressed")).toBe(before);

    for (const vp of [
      { width: 1440, height: 900, name: "1440x900" },
      { width: 1024, height: 768, name: "1024x768" },
      { width: 390, height: 844, name: "390x844" },
    ] as const) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await waitForRAF(page);
      await waitForRAF(page);
      await noHorizontalOverflow(page, vp.name);
      // explicit rendered-state condition for screenshot: viewport canvas has nonzero size
      await expect
        .poll(
          async () =>
            await page
              .locator("#viewport-canvas")
              .evaluate((c) => (c as HTMLCanvasElement).width),
          { timeout: 5_000 },
        )
        .toBeGreaterThan(0);
      const buf = await page.screenshot({ fullPage: false });
      expect(buf.length).toBeGreaterThan(1000);
      await expect(page.locator("#generate-btn")).toBeVisible();
      await expect(page.locator("#status")).toBeVisible();
    }

    assertNoObservability(obs, "flow8");
  });
});
