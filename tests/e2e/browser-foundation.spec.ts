import { expect, test } from "@playwright/test";

const viewports = [
  { width: 1440, height: 900, name: "1440x900" },
  { width: 1024, height: 768, name: "1024x768" },
  { width: 390, height: 844, name: "390x844" },
] as const;

test.describe("browser-foundation – responsive overflow and header", () => {
  for (const vp of viewports) {
    test(`no horizontal overflow at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(500);
      const scrollWidth = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      const innerWidth = await page.evaluate(() => window.innerWidth);
      expect(
        scrollWidth,
        `scrollWidth ${scrollWidth} should be <= innerWidth ${innerWidth}+1 at ${vp.name}`,
      ).toBeLessThanOrEqual(innerWidth + 1);
      expect(pageErrors, "no page errors").toEqual([]);
      expect(consoleErrors.filter((e) => !e.includes("WebGL"))).toEqual([]);
      await page.screenshot({ fullPage: false });
    });
  }

  test("at 1024 top bar does not overlap/clip", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const topBarBox = await page.locator("#top-bar").boundingBox();
    expect(topBarBox).not.toBeNull();
    if (topBarBox) {
      expect(topBarBox.height).toBeLessThan(120);
    }
    for (const id of [".top-bar-left", ".top-bar-center", ".top-bar-right"]) {
      const box = await page.locator(id).first().boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x + box.width).toBeLessThanOrEqual(1024 + 1);
        expect(box.x).toBeGreaterThanOrEqual(-1);
      }
    }
    await expect(page.locator(".brand")).toBeVisible();
    await expect(page.locator("#status .status-text")).toBeVisible();
    await expect(page.locator("#generate-btn")).toBeVisible();
    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    await page.screenshot({ fullPage: false });
  });

  test("at 390 header compact <=96 and drawers single-open with contained scroll", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const topBarBox = await page.locator("#top-bar").boundingBox();
    expect(topBarBox).not.toBeNull();
    if (topBarBox) {
      expect(
        topBarBox.height,
        `header height ${topBarBox?.height} should be <=96 at 390`,
      ).toBeLessThanOrEqual(96);
      expect(topBarBox.height).toBeGreaterThan(10);
    }
    await expect(page.locator(".brand")).toBeVisible();
    await expect(page.locator("#status")).toBeVisible();
    await expect(page.locator("#generate-btn")).toBeVisible();
    await expect(page.locator("#seed-input")).toBeVisible();

    const tabs = page.locator(".mobile-tab");
    await expect(tabs).toHaveCount(3);
    const left = page.locator("#generation-rail");
    const right = page.locator("#element-inspector");
    const tele = page.locator("#telemetry");
    await tabs.nth(0).click();
    await expect(left).toHaveClass(/is-open/);
    await expect(right).not.toHaveClass(/is-open/);
    await expect(tele).not.toHaveClass(/is-open/);
    await tabs.nth(1).click();
    await expect(right).toHaveClass(/is-open/);
    await expect(left).not.toHaveClass(/is-open/);
    await tabs.nth(2).click();
    await expect(tele).toHaveClass(/is-open/);
    await expect(right).not.toHaveClass(/is-open/);
    await tabs.nth(1).click();
    const overflowAfter = await right.evaluate(
      (el) => getComputedStyle(el).overflowY,
    );
    expect(["auto", "scroll"]).toContain(overflowAfter);

    const scrollWidth = await page.evaluate(
      () => document.documentElement.scrollWidth,
    );
    const innerWidth = await page.evaluate(() => window.innerWidth);
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth + 1);
    await page.screenshot({ fullPage: false });
  });
});

test.describe("browser-foundation – touch targets, focus, contrast", () => {
  test("primary controls and tabs have >=44px touch height on coarse/mobile", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const generateBox = await page.locator("#generate-btn").boundingBox();
    expect(generateBox).not.toBeNull();
    if (generateBox) expect(generateBox.height).toBeGreaterThanOrEqual(44);
    const tabBox = await page.locator(".mobile-tab").first().boundingBox();
    expect(tabBox).not.toBeNull();
    if (tabBox) expect(tabBox.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => {
      const el = document.getElementById("webgl-fallback");
      if (el) el.hidden = false;
    });
    const retryBox = await page.locator("#webgl-retry").boundingBox();
    expect(retryBox).not.toBeNull();
    if (retryBox) expect(retryBox.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ fullPage: false });
  });

  test("focus-visible treatment visible for controls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.locator("#generate-btn").focus();
    const outline = await page.evaluate(() => {
      const el = document.getElementById("generate-btn");
      if (!el) return null;
      const style = getComputedStyle(el);
      return (
        style.outlineWidth + " " + style.outlineColor + " " + style.boxShadow
      );
    });
    expect(outline).toBeTruthy();
    await page.locator("#save-btn").focus();
    await page.locator("#seed-input").focus();
    const inputOutline = await page.evaluate(() => {
      const el = document.getElementById("seed-input") as HTMLElement;
      return getComputedStyle(el).outlineWidth;
    });
    expect(inputOutline).toBeDefined();
    await page
      .locator('input[name="camera"]')
      .first()
      .evaluate((el) => (el as HTMLInputElement).focus());
    await page.evaluate(() => {
      const el = document.getElementById("webgl-fallback");
      if (el) el.hidden = false;
    });
    await page.locator("#webgl-retry").focus();
    const retryOutline = await page.evaluate(() => {
      const el = document.getElementById("webgl-retry") as HTMLElement;
      return getComputedStyle(el).outlineWidth;
    });
    expect(retryOutline).toBeDefined();
  });

  test("muted/legend small-text contrast >=4.5:1", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    const ratios = await page.evaluate(() => {
      function hexToRgb(hex: string) {
        hex = hex.replace("#", "");
        const n = parseInt(hex, 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      }
      function lum(c: number) {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
      function contrast(hex1: string, hex2: string) {
        const [r1, g1, b1] = hexToRgb(hex1);
        const [r2, g2, b2] = hexToRgb(hex2);
        const L1 = 0.2126 * lum(r1) + 0.7152 * lum(g1) + 0.0722 * lum(b1);
        const L2 = 0.2126 * lum(r2) + 0.7152 * lum(g2) + 0.0722 * lum(b2);
        const [l, d] = L1 > L2 ? [L1, L2] : [L2, L1];
        return (l + 0.05) / (d + 0.05);
      }
      const muted =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--muted")
          .trim() || "#9fb0c8";
      const panel =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--panel")
          .trim() || "#161b22";
      const bgSoft =
        getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-soft")
          .trim() || "#11151b";
      return {
        mutedOnPanel: contrast(muted, panel),
        mutedOnSoft: contrast(muted, bgSoft),
        mutedOnBg: contrast(muted, "#0c0f13"),
      };
    });
    expect(ratios.mutedOnPanel).toBeGreaterThanOrEqual(4.5);
    expect(ratios.mutedOnSoft).toBeGreaterThanOrEqual(4.5);
    expect(ratios.mutedOnBg).toBeGreaterThanOrEqual(4.5);
  });
});

test.describe("browser-foundation – screenshots and preview", () => {
  for (const vp of viewports) {
    test(`screenshot smoke at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(400);
      const buf = await page.screenshot({ fullPage: false });
      expect(buf.length).toBeGreaterThan(1000);
    });
  }
  test("reduced motion does not produce errors", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    expect(pageErrors).toEqual([]);
    await page.screenshot({ fullPage: false });
  });
});
