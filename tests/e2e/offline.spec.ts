import { expect, test } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";

const artifactPath = fileURLToPath(
  new URL("../../apps/web/dist/OpenVibeCoaster.html", import.meta.url),
);
const artifactFileUrl = pathToFileURL(artifactPath).href;

test.use({ launchOptions: { args: ["--disable-webgl"] } });

test("portable artifact runs directly from file://", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const disallowedRequests: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("request", (request) => {
    const url = request.url();
    const allowed =
      url === artifactFileUrl ||
      url.startsWith("data:") ||
      url.startsWith("blob:");
    if (!allowed) {
      disallowedRequests.push(url);
    }
  });

  await page.goto(artifactFileUrl, {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator("#generate-btn")).toBeVisible();
  await expect(page.locator("#seed-input")).toBeEnabled();
  await page.locator("#seed-input").fill("1337");
  await page.locator("#generate-btn").click();
  // realistic engineering bound: 90s as per acceptance-helpers
  await expect(page.locator("#status")).toHaveAttribute("data-state", "ready", {
    timeout: 90_000,
  });
  const checksumEl = page.locator('[data-testid="compiled-checksum"]');
  await expect(checksumEl).toBeVisible();
  const checksumAttr =
    (await checksumEl.getAttribute("data-checksum")) ??
    (await checksumEl.getAttribute("data-compiled-checksum")) ??
    "";
  expect(checksumAttr).toMatch(/^[0-9a-f]{8}$/i);
  expect(checksumAttr.length).toBeGreaterThan(0);
  const lengthEl = page.locator('[data-testid="track-length"]');
  await expect(lengthEl).toBeVisible();
  const lengthRaw = await lengthEl.getAttribute("data-length-m");
  expect(
    lengthRaw,
    "data-length-m required for offline artifact",
  ).not.toBeNull();
  expect(Number.isFinite(Number.parseFloat(lengthRaw!))).toBe(true);
  expect(Number.parseFloat(lengthRaw!)).toBeGreaterThan(0);
  await page.locator("#mute-btn").click();
  await expect(page.locator("#mute-btn")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  expect(
    disallowedRequests,
    `disallowed requests (only ${artifactFileUrl} plus data: and blob: allowed): ${disallowedRequests.join(", ")}`,
  ).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
