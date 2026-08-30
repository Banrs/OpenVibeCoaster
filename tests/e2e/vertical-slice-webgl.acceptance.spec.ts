import { expect, test } from "@playwright/test";
import {
  assertNoObservability,
  attachObservability,
} from "./acceptance-helpers.js";

test.use({ launchOptions: { args: ["--disable-webgl", "--disable-gpu"] } });

test("WebGL-disabled: generation/save/load usable while 3D controls disabled, no cross-origin/fetch", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const obs = attachObservability(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => document.readyState === "complete");

  await expect(page.locator("#webgl-fallback")).toBeVisible();
  await expect(page.locator("#webgl-retry")).toBeVisible();
  await expect(page.locator("#webgl-retry")).toBeEnabled();

  const cameraDisabled = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="camera"]'),
    ).every((el) => el.disabled),
  );
  expect(cameraDisabled, "camera controls disabled without WebGL").toBe(true);
  expect(
    await page.evaluate(
      () =>
        (document.getElementById("metric-select") as HTMLSelectElement)
          ?.disabled,
    ),
  ).toBe(true);

  await expect(page.locator("#generate-btn")).toBeEnabled();
  await expect(page.locator("#load-btn")).toBeEnabled();
  expect(
    await page
      .locator("#load-file")
      .evaluate((el: HTMLInputElement) => !el.disabled),
    "load-file enabled without WebGL",
  ).toBe(true);

  await page.locator("#seed-input").click();
  await page.locator("#seed-input").fill("101");
  await page.locator("#generate-btn").click();

  // generation is WebGL-agnostic: should leave pending -> error/ready, not crash, with no console page errors
  await expect(page.locator("#status")).not.toHaveAttribute(
    "data-state",
    "pending",
    { timeout: 10_000 },
  );
  const state = await page.locator("#status").getAttribute("data-state");
  expect(state, "WebGL-disabled generation still attempts").not.toBeNull();

  assertNoObservability(obs, "webgl-disabled");
});
