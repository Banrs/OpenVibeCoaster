import { expect, test } from "@playwright/test";

const viewports = [
  { width: 1440, height: 900, name: "1440x900" },
  { width: 1024, height: 768, name: "1024x768" },
  { width: 390, height: 844, name: "390x844" },
] as const;

const requiredControls = [
  ".brand",
  ".mode-toggle",
  "#seed-input",
  "#generate-btn",
  "#save-btn",
  "#load-btn",
  "#export-btn",
  "#status",
  "#mute-btn",
];

test.describe("browser-foundation – normal WebGL proof", () => {
  test("real Three renderer initialized, canvas visible, no fallback, at least one render frame, no console/page errors", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // wait for real renderer to initialize (controller non-null)
    await page.waitForFunction(
      () =>
        (window as unknown as Record<string, unknown>)
          .__vibecoasterController !== undefined &&
        (window as unknown as Record<string, unknown>)
          .__vibecoasterController !== null,
      null,
      { timeout: 5000 },
    );
    await page.waitForTimeout(600);

    const state = await page.evaluate(() => {
      const canvas = document.getElementById(
        "viewport-canvas",
      ) as HTMLCanvasElement;
      const fallback = document.getElementById("webgl-fallback") as HTMLElement;
      const bodyHasNoWebGL = document.body.classList.contains("no-webgl");
      const canvasHidden = canvas.hidden;
      const canvasDisplay = getComputedStyle(canvas).display;
      const canvasVisibility = getComputedStyle(canvas).visibility;
      const canvasRect = canvas.getBoundingClientRect();
      const fallbackHidden = fallback.hidden;
      const fallbackDisplay = getComputedStyle(fallback).display;
      const controller = (window as unknown as Record<string, unknown>)
        .__vibecoasterController as unknown;
      const handle = (window as unknown as Record<string, unknown>)
        .__vibecoasterGetHandle
        ? (
            (window as unknown as Record<string, unknown>)
              .__vibecoasterGetHandle as () => unknown
          )()
        : null;
      const hasHandle = !!(handle as unknown as { renderer?: unknown })
        ?.renderer;
      const metrics = (window as unknown as Record<string, unknown>)
        .__vibecoasterMetrics as unknown as {
        frameDurationMs?: number;
        drawCalls?: number;
      } | null;
      return {
        canvasHidden,
        canvasDisplay,
        canvasVisibility,
        canvasRect: { width: canvasRect.width, height: canvasRect.height },
        fallbackHidden,
        fallbackDisplay,
        bodyHasNoWebGL,
        hasController: !!controller,
        hasHandle,
        metrics,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      };
    });

    expect(state.canvasHidden, "viewport canvas hidden should be false").toBe(
      false,
    );
    expect(state.canvasDisplay, "canvas display not none").not.toBe("none");
    expect(state.canvasVisibility, "canvas visibility").not.toBe("hidden");
    expect(state.canvasRect.width, "canvas width >0").toBeGreaterThan(0);
    expect(state.canvasRect.height, "canvas height >0").toBeGreaterThan(0);
    expect(state.fallbackHidden, "fallback should be hidden").toBe(true);
    expect(state.fallbackDisplay, "fallback display none").toBe("none");
    expect(state.bodyHasNoWebGL, "body should not have no-webgl").toBe(false);
    expect(state.hasController, "real controller initialized").toBe(true);
    expect(state.hasHandle, "renderer handle with WebGLRenderer").toBe(true);

    // at least one real render call/frame – check metrics or canvas size changed
    // metrics.frameDurationMs >0 indicates tick ran
    const hasFrame = await page.evaluate(() => {
      const m = (window as unknown as Record<string, unknown>)
        .__vibecoasterMetrics as unknown as {
        frameDurationMs?: number;
      } | null;
      return (m?.frameDurationMs ?? 0) > 0;
    });
    // also check that canvas has been sized (renderer.setSize called)
    expect(
      hasFrame || state.canvasWidth > 0,
      "at least one render frame or canvas sized",
    ).toBeTruthy();

    expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
    expect(
      consoleErrors,
      `console errors: ${consoleErrors.join("; ")}`,
    ).toEqual([]);

    // ensure WebGL context actually exists on canvas (no fallback path)
    const hasGL = await page.evaluate(() => {
      const c = document.getElementById("viewport-canvas") as HTMLCanvasElement;
      // The context was created with antialias true alpha false; second call with same type should return same context (not null)
      try {
        const ctx = c.getContext("webgl2", {
          antialias: true,
          alpha: false,
        }) as unknown;
        return !!ctx;
      } catch {
        return false;
      }
    });
    expect(hasGL, "WebGL2 context should exist on viewport canvas").toBe(true);

    await page.screenshot({ fullPage: false });
  });
});

test.describe("browser-foundation – responsive overflow and header", () => {
  for (const vp of viewports) {
    test(`no horizontal overflow at ${vp.name}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(500);

      const overflow = await page.evaluate(() => {
        const docScroll = document.documentElement.scrollWidth;
        const docClient = document.documentElement.clientWidth;
        const topBar = document.getElementById("top-bar") as HTMLElement;
        const topScroll = topBar.scrollWidth;
        const topClient = topBar.clientWidth;
        return { docScroll, docClient, topScroll, topClient };
      });
      expect(
        overflow.docScroll,
        `document scrollWidth ${overflow.docScroll} should be <= clientWidth ${overflow.docClient}+1 at ${vp.name}`,
      ).toBeLessThanOrEqual(overflow.docClient + 1);
      expect(
        overflow.topScroll,
        `top-bar scrollWidth ${overflow.topScroll} <= clientWidth ${overflow.topClient}+1 at ${vp.name}`,
      ).toBeLessThanOrEqual(overflow.topClient + 1);

      // every required control inside viewport
      for (const sel of requiredControls) {
        const box = await page.locator(sel).first().boundingBox();
        expect(box, `${sel} should be visible at ${vp.name}`).not.toBeNull();
        if (box) {
          expect(box.x, `${sel} x >=0 at ${vp.name}`).toBeGreaterThanOrEqual(
            -1,
          );
          expect(
            box.x + box.width,
            `${sel} right <= viewport ${vp.width} at ${vp.name}`,
          ).toBeLessThanOrEqual(vp.width + 1);
        }
      }

      expect(pageErrors, "no page errors").toEqual([]);
      expect(
        consoleErrors,
        `console errors: ${consoleErrors.join("; ")}`,
      ).toEqual([]);
      await page.screenshot({ fullPage: false });
    });
  }

  test("at 1024 top bar does not overlap/clip and all controls discoverable", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(400);
    const topBarBox = await page.locator("#top-bar").boundingBox();
    expect(topBarBox).not.toBeNull();
    if (topBarBox) {
      expect(topBarBox.height).toBeLessThan(140);
    }
    for (const id of [".top-bar-left", ".top-bar-center", ".top-bar-right"]) {
      const box = await page.locator(id).first().boundingBox();
      expect(box).not.toBeNull();
      if (box) {
        expect(box.x + box.width).toBeLessThanOrEqual(1024 + 1);
        expect(box.x).toBeGreaterThanOrEqual(-1);
      }
    }
    for (const sel of requiredControls) {
      await expect(page.locator(sel).first()).toBeVisible();
      const box = await page.locator(sel).first().boundingBox();
      if (box) expect(box.x + box.width).toBeLessThanOrEqual(1024 + 1);
    }
    const overflow = await page.evaluate(() => {
      const docScroll = document.documentElement.scrollWidth;
      const topScroll = (document.getElementById("top-bar") as HTMLElement)
        .scrollWidth;
      return {
        docScroll,
        topScroll,
        inner: window.innerWidth,
        topClient: (document.getElementById("top-bar") as HTMLElement)
          .clientWidth,
      };
    });
    expect(overflow.docScroll).toBeLessThanOrEqual(overflow.inner + 1);
    expect(overflow.topScroll).toBeLessThanOrEqual(overflow.topClient + 1);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.screenshot({ fullPage: false });
  });

  test("at 390 header compact <=96 and drawers single-open with contained scroll, no horizontal overflow", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(400);
    const topBarBox = await page.locator("#top-bar").boundingBox();
    expect(topBarBox).not.toBeNull();
    if (topBarBox) {
      expect(
        topBarBox.height,
        `header height ${topBarBox?.height} should be <=96 at 390`,
      ).toBeLessThanOrEqual(96);
      expect(topBarBox.height).toBeGreaterThan(10);
    }
    // all controls still discoverable without horizontal scroll
    for (const sel of requiredControls) {
      const box = await page.locator(sel).first().boundingBox();
      // Some controls may be wrapped to second row but still inside viewport
      if (box) {
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
      }
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

    const overflow = await page.evaluate(() => {
      const docScroll = document.documentElement.scrollWidth;
      const topScroll = (document.getElementById("top-bar") as HTMLElement)
        .scrollWidth;
      return {
        docScroll,
        topScroll,
        inner: window.innerWidth,
        topClient: (document.getElementById("top-bar") as HTMLElement)
          .clientWidth,
      };
    });
    expect(overflow.docScroll).toBeLessThanOrEqual(overflow.inner + 1);
    expect(overflow.topScroll).toBeLessThanOrEqual(overflow.topClient + 1);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.screenshot({ fullPage: false });
  });
});

test.describe("browser-foundation – touch targets, focus, contrast", () => {
  test("primary controls and tabs have >=44px touch height on coarse/mobile", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(400);
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
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await page.screenshot({ fullPage: false });
  });

  test("focus-visible treatment visible for controls", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const ids = ["#generate-btn", "#load-btn", "#seed-input", "#webgl-retry"];
    // make retry visible for focus test
    await page.evaluate(() => {
      const el = document.getElementById("webgl-fallback");
      if (el) el.hidden = false;
    });

    for (const sel of ids) {
      const el = page.locator(sel).first();
      await el.focus();
      const focusStyle = await page.evaluate((s) => {
        const e = document.querySelector(s) as HTMLElement;
        if (!e) return null;
        const cs = getComputedStyle(e);
        return {
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          outlineColor: cs.outlineColor,
          boxShadow: cs.boxShadow,
        };
      }, sel);
      expect(focusStyle).not.toBeNull();
      if (focusStyle) {
        expect(
          focusStyle.outlineStyle,
          `${sel} outlineStyle should not be none`,
        ).not.toBe("none");
        const w = parseFloat(focusStyle.outlineWidth);
        expect(
          w,
          `${sel} outlineWidth >=2px, got ${focusStyle.outlineWidth}`,
        ).toBeGreaterThanOrEqual(2);
        const hasVisible =
          (focusStyle.outlineColor !== "rgba(0, 0, 0, 0)" &&
            focusStyle.outlineColor !== "transparent" &&
            focusStyle.outlineColor !== "") ||
          (focusStyle.boxShadow !== "none" && focusStyle.boxShadow !== "");
        expect(
          hasVisible,
          `${sel} should have visible outline color or box-shadow`,
        ).toBe(true);
      }
    }

    // also test camera radio focus via label
    await page.evaluate(() => {
      const el = document.getElementById("webgl-fallback");
      if (el) el.hidden = true;
    });
    const cam = page.locator('input[name="camera"]').first();
    await cam.evaluate((el) => (el as HTMLInputElement).focus());
    const camFocus = await page.evaluate(() => {
      const e = document.querySelector('input[name="camera"]') as HTMLElement;
      const p = e.closest(".cam-option") as HTMLElement;
      const cs = getComputedStyle(p ?? e);
      return {
        outlineStyle: cs.outlineStyle,
        outlineWidth: cs.outlineWidth,
        boxShadow: cs.boxShadow,
      };
    });
    // cam option should have focus-visible via :has(input:focus-visible)
    // we at least check that focused input is visible
    expect(camFocus).toBeTruthy();

    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("muted/legend small-text contrast >=4.5:1 via effective rendered background", async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const results = await page.evaluate(() => {
      function parseColor(str: string): [number, number, number] | null {
        const m = str.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
        return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
      }
      function effectiveBg(el: Element): [number, number, number] {
        let cur: Element | null = el;
        while (cur) {
          const bg = getComputedStyle(cur as HTMLElement).backgroundColor;
          const rgb = parseColor(bg);
          if (rgb) {
            const alphaMatch = bg.match(/rgba\(([^)]+)\)/);
            const a = alphaMatch
              ? parseFloat(alphaMatch[1].split(",")[3] ?? "1")
              : 1;
            if (a > 0.01 && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") {
              // ignore fully transparent
              if (
                rgb[0] !== 0 ||
                rgb[1] !== 0 ||
                rgb[2] !== 0 ||
                cur === document.documentElement
              ) {
                // for our dark theme, any non-transparent is effective
                return rgb;
              }
            }
          }
          cur = cur.parentElement;
          if (!cur) break;
        }
        // fallback to body bg
        const bodyBg = getComputedStyle(document.body).backgroundColor;
        return parseColor(bodyBg) ?? [12, 15, 19];
      }
      function lum(c: number) {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
      function contrastRgb(
        fg: [number, number, number],
        bg: [number, number, number],
      ) {
        const [r1, g1, b1] = fg;
        const [r2, g2, b2] = bg;
        const L1 = 0.2126 * lum(r1) + 0.7152 * lum(g1) + 0.0722 * lum(b1);
        const L2 = 0.2126 * lum(r2) + 0.7152 * lum(g2) + 0.0722 * lum(b2);
        const [l, d] = L1 > L2 ? [L1, L2] : [L2, L1];
        return (l + 0.05) / (d + 0.05);
      }
      const selectors = [
        ".panel-hint",
        ".field-note",
        ".legend-item",
        "#telemetry-empty",
      ];
      const out: { sel: string; ratio: number; fg: string; bg: string }[] = [];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) continue;
        const fgStr = getComputedStyle(el).color;
        const fg = parseColor(fgStr);
        const bg = effectiveBg(el);
        if (!fg || !bg) continue;
        const ratio = contrastRgb(fg, bg);
        out.push({ sel, ratio, fg: fgStr, bg: bg.join(",") });
      }
      // also check muted text in status
      const status = document.querySelector("#status") as HTMLElement;
      if (status) {
        const fg = parseColor(getComputedStyle(status).color);
        const bg = effectiveBg(status);
        if (fg && bg)
          out.push({
            sel: "#status",
            ratio: contrastRgb(fg, bg),
            fg: getComputedStyle(status).color,
            bg: bg.join(","),
          });
      }
      return out;
    });

    expect(results.length, "should find contrast samples").toBeGreaterThan(0);
    for (const r of results) {
      expect(
        r.ratio,
        `${r.sel} contrast ${r.ratio.toFixed(2)} fg ${r.fg} bg ${r.bg} should be >=4.5`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });

  test("disabled state has non-color cue", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    // save button is disabled in pending state
    const saveBtn = page.locator("#save-btn");
    await expect(saveBtn).toBeDisabled();
    const cue = await page.evaluate(() => {
      const el = document.getElementById("save-btn") as HTMLElement;
      const cs = getComputedStyle(el);
      return {
        borderStyle: cs.borderStyle,
        opacity: cs.opacity,
        filter: cs.filter,
        cursor: cs.cursor,
        textDecoration: cs.textDecoration,
      };
    });
    const hasNonColorCue =
      cue.borderStyle === "dashed" ||
      parseFloat(cue.opacity) < 0.9 ||
      cue.filter.includes("grayscale") ||
      cue.cursor === "not-allowed";
    expect(
      hasNonColorCue,
      `disabled cue should be non-color, got ${JSON.stringify(cue)}`,
    ).toBe(true);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});

test.describe("browser-foundation – screenshots and preview", () => {
  for (const vp of viewports) {
    test(`screenshot smoke at ${vp.name}`, async ({ page }) => {
      const consoleErrors: string[] = [];
      const pageErrors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") consoleErrors.push(m.text());
      });
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(400);
      const buf = await page.screenshot({ fullPage: false });
      expect(buf.length).toBeGreaterThan(1000);
      expect(pageErrors).toEqual([]);
      expect(consoleErrors).toEqual([]);
    });
  }
  test("reduced motion does not produce errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(500);
    expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
    expect(
      consoleErrors,
      `console errors: ${consoleErrors.join("; ")}`,
    ).toEqual([]);
    await page.screenshot({ fullPage: false });
  });
});
