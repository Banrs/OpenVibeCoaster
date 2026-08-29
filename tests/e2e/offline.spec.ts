import { expect, test } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";

const artifactPath = fileURLToPath(
  new URL("../../apps/web/dist/OpenVibeCoaster.html", import.meta.url),
);

test.use({ launchOptions: { args: ["--disable-webgl"] } });

test("portable artifact runs directly from file://", async ({ page }) => {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const externalRequests: string[] = [];

  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  page.on("request", (request) => {
    if (/^(?:https?:|wss?:)/i.test(request.url())) {
      externalRequests.push(request.url());
    }
  });

  await page.goto(pathToFileURL(artifactPath).href, {
    waitUntil: "domcontentloaded",
  });

  await expect(page.locator("#generate-btn")).toBeVisible();
  await expect(page.locator("#seed-input")).toBeEnabled();
  await page.locator("#seed-input").fill("1337");
  await page.locator("#mute-btn").click();
  await expect(page.locator("#mute-btn")).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  expect(externalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
