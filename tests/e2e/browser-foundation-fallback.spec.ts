import { expect, test } from "@playwright/test";

test.use({ launchOptions: { args: ["--disable-webgl", "--disable-gpu"] } });

test("WebGL fallback visible, camera/metric disabled/hidden, retry operable, no errors", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") {
      const text = m.text();
      // Three logs expected WebGL context failures when --disable-webgl; not app-attributable page errors
      if (text.includes("THREE.WebGLRenderer")) return;
      consoleErrors.push(text);
    }
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
  // retry should be clickable through overlay – not intercepted
  await page.locator("#webgl-retry").click();
  await page.waitForTimeout(300);
  await expect(fallback).toBeVisible();
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
  await page.screenshot({ fullPage: false });
});

test("reduced motion fallback still operable", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForTimeout(500);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await expect(page.locator("#webgl-fallback")).toBeVisible();
  expect(pageErrors).toEqual([]);
  await page.screenshot({ fullPage: false });
});
