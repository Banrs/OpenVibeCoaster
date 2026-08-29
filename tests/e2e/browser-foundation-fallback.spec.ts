import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--disable-webgl", "--disable-gpu"] } });

test("WebGL fallback visible, camera/metric disabled/hidden, retry operable, no errors", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleEvents: { type: string; text: string }[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    consoleEvents.push({ type: m.type(), text: m.text() });
  });

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(800);
  const fallback = page.locator("#webgl-fallback");
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText("WebGL unavailable");
  await expect(page.locator("#webgl-retry")).toBeVisible();
  await expect(page.locator("#webgl-retry")).toBeEnabled();
  const cameraDisabled = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="camera"]'),
    ).every((el) => el.disabled),
  );
  expect(cameraDisabled).toBe(true);
  const metricDisabled = await page.evaluate(
    () =>
      (document.getElementById("metric-select") as HTMLSelectElement)?.disabled,
  );
  expect(metricDisabled).toBe(true);
  // verify fallback not invoked Three – no handle, snapshot says not ready, hasWebGL false
  const snap = await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>)
      .__vibecoasterSnapshot as unknown as
      (() => Record<string, unknown>) | undefined;
    if (!fn) return null;
    const s = fn() as Record<string, unknown>;
    return {
      rendererReady: s.rendererReady,
      hasWebGL: s.hasWebGL,
      successfulRenderCount: s.successfulRenderCount,
      frozen: Object.isFrozen(s),
    };
  });
  expect(snap).not.toBeNull();
  if (snap) {
    expect(snap.rendererReady, "rendererReady false in fallback").toBe(false);
    expect(snap.hasWebGL, "hasWebGL false in fallback").toBe(false);
    expect(
      snap.successfulRenderCount,
      "no successful renders in fallback",
    ).toBe(0);
    expect(snap.frozen, "snapshot frozen").toBe(true);
  }
  const noHandle = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      hasController:
        "__vibecoasterController" in w &&
        w.__vibecoasterController !== undefined,
      hasHandle:
        "__vibecoasterRendererHandle" in w &&
        w.__vibecoasterRendererHandle !== undefined,
    };
  });
  expect(noHandle.hasController, "no controller handle in fallback").toBe(
    false,
  );
  expect(noHandle.hasHandle, "no renderer handle in fallback").toBe(false);

  await page.locator("#webgl-retry").click();
  await page.waitForTimeout(300);
  await expect(fallback).toBeVisible();
  // after retry, still fallback but no errors, listeners were before navigation
  expect(pageErrors).toEqual([]);
  expect(consoleEvents).toEqual([]);
});

test("reduced motion fallback still operable", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleEvents: { type: string; text: string }[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    consoleEvents.push({ type: m.type(), text: m.text() });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);
  await expect(page.locator("#webgl-fallback")).toBeVisible();
  const snap = await page.evaluate(() => {
    const fn = (window as unknown as Record<string, unknown>)
      .__vibecoasterSnapshot as unknown as
      (() => Record<string, unknown>) | undefined;
    if (!fn) return null;
    return fn() as Record<string, unknown>;
  });
  expect(snap).not.toBeNull();
  if (snap) {
    expect(snap.hasWebGL).toBe(false);
    expect(snap.reducedMotion).toBe(true);
  }
  expect(pageErrors).toEqual([]);
  expect(consoleEvents).toEqual([]);
});
