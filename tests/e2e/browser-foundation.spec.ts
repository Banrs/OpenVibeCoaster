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
  test("real Three renderer initialized, canvas visible, no fallback, at least one successful render, no console/page errors", async ({
    page,
  }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    await page.waitForFunction(
      () => {
        const snap = (window as unknown as Record<string, unknown>)
          .__vibecoasterSnapshot as unknown as (() => unknown) | undefined;
        if (!snap) return false;
        try {
          const s = snap() as Record<string, unknown>;
          return s.rendererReady === true;
        } catch {
          return false;
        }
      },
      null,
      { timeout: 8000 },
    );

    // wait a bit for at least one successful render tick
    await page.waitForFunction(
      () => {
        const snap = (window as unknown as Record<string, unknown>)
          .__vibecoasterSnapshot as unknown as (() => unknown) | undefined;
        if (!snap) return false;
        try {
          const s = snap() as Record<string, unknown>;
          return (s.successfulRenderCount as number) > 0;
        } catch {
          return false;
        }
      },
      null,
      { timeout: 8000 },
    );

    await page.waitForTimeout(400);

    const snap = await page.evaluate(() => {
      const fn = (window as unknown as Record<string, unknown>)
        .__vibecoasterSnapshot as unknown as () => Record<string, unknown>;
      const s = fn();
      return {
        rendererReady: s.rendererReady,
        successfulRenderCount: s.successfulRenderCount,
        generationStatus: s.generationStatus,
        hasWebGL: s.hasWebGL,
        reducedMotion: s.reducedMotion,
        frozen: Object.isFrozen(s),
      };
    });

    expect(snap.frozen, "snapshot should be frozen").toBe(true);
    expect(snap.rendererReady, "production snapshot rendererReady true").toBe(
      true,
    );
    expect(
      snap.successfulRenderCount as number,
      "successfulRenderCount >0 proved after render returns",
    ).toBeGreaterThan(0);
    expect(snap.hasWebGL, "snapshot hasWebGL true").toBe(true);
    // generationStatus is pending initially (no track) but renderer ready
    expect(typeof snap.generationStatus).toBe("string");

    // ensure no mutable renderer-handle/state globals exposed (lifecycle controller may remain for internal test compatibility)
    const exposed = await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      return {
        hasHandle:
          "__vibecoasterRendererHandle" in w &&
          w.__vibecoasterRendererHandle !== undefined,
        hasGetHandle: typeof w.__vibecoasterGetHandle === "function",
        hasGetController: typeof w.__vibecoasterGetController === "function",
        hasState:
          "__vibecoasterState" in w && w.__vibecoasterState !== undefined,
      };
    });
    expect(
      exposed.hasHandle,
      "should not expose __vibecoasterRendererHandle",
    ).toBe(false);
    expect(
      exposed.hasGetHandle,
      "should not expose __vibecoasterGetHandle",
    ).toBe(false);
    expect(
      exposed.hasGetController,
      "should not expose __vibecoasterGetController",
    ).toBe(false);
    expect(
      exposed.hasState,
      "should not expose mutable __vibecoasterState",
    ).toBe(false);

    const dom = await page.evaluate(() => {
      const canvas = document.getElementById(
        "viewport-canvas",
      ) as HTMLCanvasElement;
      const fallback = document.getElementById("webgl-fallback") as HTMLElement;
      return {
        canvasHidden: canvas.hidden,
        canvasDisplay: getComputedStyle(canvas).display,
        canvasVisibility: getComputedStyle(canvas).visibility,
        canvasRect: canvas.getBoundingClientRect(),
        fallbackHidden: fallback.hidden,
        fallbackDisplay: getComputedStyle(fallback).display,
        bodyHasNoWebGL: document.body.classList.contains("no-webgl"),
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      };
    });

    expect(dom.canvasHidden, "viewport canvas hidden false").toBe(false);
    expect(dom.canvasDisplay, "canvas display not none").not.toBe("none");
    expect(dom.canvasVisibility, "canvas visibility").not.toBe("hidden");
    expect(dom.canvasRect.width, "canvas width >0").toBeGreaterThan(0);
    expect(dom.canvasRect.height, "canvas height >0").toBeGreaterThan(0);
    expect(dom.fallbackHidden, "fallback hidden true").toBe(true);
    expect(dom.fallbackDisplay, "fallback display none").toBe("none");
    expect(dom.bodyHasNoWebGL, "body should not have no-webgl").toBe(false);
    expect(dom.canvasWidth, "canvas width sized").toBeGreaterThan(0);
    expect(dom.canvasHeight, "canvas height sized").toBeGreaterThan(0);

    const hasGL = await page.evaluate(() => {
      const c = document.getElementById("viewport-canvas") as HTMLCanvasElement;
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

    expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
    expect(
      consoleEvents,
      `console errors: ${JSON.stringify(consoleEvents)}`,
    ).toEqual([]);
  });
});

test.describe("browser-foundation – responsive overflow and header", () => {
  for (const vp of viewports) {
    test(`no horizontal overflow at ${vp.name}`, async ({ page }) => {
      const consoleEvents: { type: string; text: string }[] = [];
      const pageErrors: string[] = [];
      page.on("console", (m) => {
        consoleEvents.push({ type: m.type(), text: m.text() });
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
        consoleEvents,
        `console errors: ${JSON.stringify(consoleEvents)}`,
      ).toEqual([]);
    });
  }

  test("at 1024 top bar does not overlap/clip and all controls discoverable", async ({
    page,
  }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
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
    expect(consoleEvents).toEqual([]);
  });

  test("at 390 header compact <=96 and drawers single-open with contained scroll, no horizontal overflow", async ({
    page,
  }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
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
    for (const sel of requiredControls) {
      const box = await page.locator(sel).first().boundingBox();
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
    expect(consoleEvents).toEqual([]);
  });
});

test.describe("browser-foundation – touch targets, focus, contrast", () => {
  test("primary controls and tabs have >=44px touch height on coarse/mobile", async ({
    page,
  }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(400);
    const generateBox = await page.locator("#generate-btn").boundingBox();
    expect(generateBox).not.toBeNull();
    if (generateBox) expect(generateBox.height).toBeGreaterThanOrEqual(44);
    const tabBoxes = await page
      .locator(".mobile-tab")
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(tabBoxes.length).toBe(3);
    for (const h of tabBoxes) {
      expect(h, "each mobile tab >=44px").toBeGreaterThanOrEqual(44);
    }
    await page.evaluate(() => {
      const el = document.getElementById("webgl-fallback");
      if (el) el.hidden = false;
    });
    const retryBox = await page.locator("#webgl-retry").boundingBox();
    expect(retryBox).not.toBeNull();
    if (retryBox) expect(retryBox.height).toBeGreaterThanOrEqual(44);
    expect(pageErrors).toEqual([]);
    expect(consoleEvents).toEqual([]);
  });

  test("focus-visible treatment visible for every control, camera label, and mobile tab", async ({
    page,
  }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));

    // Test controls at desktop size
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    // make retry visible for focus test
    await page.evaluate(() => {
      const el = document.getElementById("webgl-fallback");
      if (el) el.hidden = false;
    });

    const focusControls = [
      "#generate-btn",
      "#load-btn",
      "#seed-input",
      "#webgl-retry",
    ];

    for (const sel of focusControls) {
      const el = page.locator(sel).first();
      await el.focus();
      // keyboard focus verification: element should be activeElement
      const isFocused = await page.evaluate(
        (s) => document.activeElement?.matches(s),
        sel,
      );
      expect(isFocused, `${sel} should be focused`).toBe(true);
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

    // hide fallback for camera tests
    await page.evaluate(() => {
      const el = document.getElementById("webgl-fallback");
      if (el) el.hidden = true;
    });

    // Every camera label must have visible focus treatment when its input is focused
    const camCount = await page.locator(".cam-option").count();
    expect(camCount, "should have camera options").toBeGreaterThan(0);
    for (let i = 0; i < camCount; i++) {
      const input = page.locator('input[name="camera"]').nth(i);
      await input.focus();
      const isFocused = await page.evaluate((idx) => {
        const inputs = document.querySelectorAll('input[name="camera"]');
        const el = inputs[idx] as HTMLInputElement;
        return document.activeElement === el;
      }, i);
      expect(isFocused, `camera input ${i} should be focused`).toBe(true);
      const style = await page.evaluate((idx) => {
        const inputs = document.querySelectorAll('input[name="camera"]');
        const e = inputs[idx] as HTMLElement;
        const p = e.closest(".cam-option") as HTMLElement;
        const cs = getComputedStyle(p ?? e);
        return {
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          outlineColor: cs.outlineColor,
          boxShadow: cs.boxShadow,
          borderColor: cs.borderColor,
        };
      }, i);
      expect(
        style.outlineStyle,
        `cam-option ${i} outlineStyle not none`,
      ).not.toBe("none");
      const w = parseFloat(style.outlineWidth);
      expect(w, `cam-option ${i} outlineWidth >=2px`).toBeGreaterThanOrEqual(2);
      const hasVisible =
        (style.outlineColor !== "rgba(0, 0, 0, 0)" &&
          style.outlineColor !== "transparent" &&
          style.outlineColor !== "") ||
        (style.boxShadow !== "none" && style.boxShadow !== "");
      expect(hasVisible, `cam-option ${i} visible color/shadow`).toBe(true);
    }

    // Every mobile tab must have focus treatment – test at mobile viewport where tabs visible
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    const tabCount = await page.locator(".mobile-tab").count();
    expect(tabCount, "should have 3 mobile tabs").toBe(3);
    for (let i = 0; i < tabCount; i++) {
      const tab = page.locator(".mobile-tab").nth(i);
      await tab.focus();
      const isFocused = await page.evaluate((idx) => {
        const tabs = document.querySelectorAll(".mobile-tab");
        return document.activeElement === tabs[idx];
      }, i);
      expect(isFocused, `mobile tab ${i} should be focused via keyboard`).toBe(
        true,
      );
      const style = await page.evaluate((idx) => {
        const tabs = document.querySelectorAll(".mobile-tab");
        const e = tabs[idx] as HTMLElement;
        const cs = getComputedStyle(e);
        return {
          outlineStyle: cs.outlineStyle,
          outlineWidth: cs.outlineWidth,
          outlineColor: cs.outlineColor,
          boxShadow: cs.boxShadow,
        };
      }, i);
      expect(
        style.outlineStyle,
        `mobile tab ${i} outlineStyle not none`,
      ).not.toBe("none");
      const w = parseFloat(style.outlineWidth);
      expect(w, `mobile tab ${i} outlineWidth >=2px`).toBeGreaterThanOrEqual(2);
      const hasVisible =
        (style.outlineColor !== "rgba(0, 0, 0, 0)" &&
          style.outlineColor !== "transparent" &&
          style.outlineColor !== "") ||
        (style.boxShadow !== "none" && style.boxShadow !== "");
      expect(hasVisible, `mobile tab ${i} visible color/shadow`).toBe(true);
    }

    expect(pageErrors).toEqual([]);
    expect(consoleEvents).toEqual([]);
  });

  test("muted/legend small-text contrast >=4.5:1 via effective rendered background compositing", async ({
    page,
  }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");

    const results = await page.evaluate(() => {
      function parseRgba(
        str: string,
      ): { r: number; g: number; b: number; a: number } | null {
        const m = str.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(",").map((s) => parseFloat(s.trim()));
        const r = parts[0] ?? 0;
        const g = parts[1] ?? 0;
        const b = parts[2] ?? 0;
        const a = parts.length >= 4 ? (parts[3] ?? 1) : 1;
        return { r, g, b, a };
      }
      function blend(
        fg: { r: number; g: number; b: number; a: number },
        bg: { r: number; g: number; b: number },
      ): { r: number; g: number; b: number } {
        const a = fg.a;
        return {
          r: fg.r * a + bg.r * (1 - a),
          g: fg.g * a + bg.g * (1 - a),
          b: fg.b * a + bg.b * (1 - a),
        };
      }
      function effectiveBg(el: Element): { r: number; g: number; b: number } {
        const bodyBgStr = getComputedStyle(document.body).backgroundColor;
        const cur = parseRgba(bodyBgStr) ?? { r: 12, g: 15, b: 19, a: 1 };
        let base: { r: number; g: number; b: number } = {
          r: cur.r,
          g: cur.g,
          b: cur.b,
        };
        // collect ancestors from root to element
        const ancestors: Element[] = [];
        let curEl: Element | null = el;
        while (curEl) {
          ancestors.unshift(curEl);
          curEl = curEl.parentElement;
        }
        for (const anc of ancestors) {
          const bgStr = getComputedStyle(anc as HTMLElement).backgroundColor;
          const parsed = parseRgba(bgStr);
          if (!parsed) continue;
          if (parsed.a <= 0.01) continue;
          if (parsed.a >= 0.99) {
            base = { r: parsed.r, g: parsed.g, b: parsed.b };
          } else {
            base = blend(parsed, base);
          }
        }
        return base;
      }
      function lum(c: number) {
        c = c / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      }
      function contrastRgb(
        fg: { r: number; g: number; b: number },
        bg: { r: number; g: number; b: number },
      ) {
        const L1 = 0.2126 * lum(fg.r) + 0.7152 * lum(fg.g) + 0.0722 * lum(fg.b);
        const L2 = 0.2126 * lum(bg.r) + 0.7152 * lum(bg.g) + 0.0722 * lum(bg.b);
        const [l, d] = L1 > L2 ? [L1, L2] : [L2, L1];
        return (l + 0.05) / (d + 0.05);
      }
      const selectors = [
        ".panel-hint",
        ".field-note",
        ".legend-item",
        "#telemetry-empty",
        "#status",
      ];
      const out: { sel: string; ratio: number; fg: string; bg: string }[] = [];
      for (const sel of selectors) {
        const el = document.querySelector(sel) as HTMLElement;
        if (!el) {
          out.push({ sel, ratio: -1, fg: "MISSING", bg: "MISSING" });
          continue;
        }
        const fgStr = getComputedStyle(el).color;
        const fgParsed = parseRgba(fgStr);
        const bg = effectiveBg(el);
        if (!fgParsed || !bg) {
          out.push({
            sel,
            ratio: -1,
            fg: fgStr,
            bg: `${bg.r},${bg.g},${bg.b}`,
          });
          continue;
        }
        let fgRgb: { r: number; g: number; b: number };
        if (fgParsed.a < 0.99) {
          fgRgb = blend(fgParsed, bg);
        } else {
          fgRgb = { r: fgParsed.r, g: fgParsed.g, b: fgParsed.b };
        }
        const ratio = contrastRgb(fgRgb, bg);
        out.push({
          sel,
          ratio,
          fg: fgStr,
          bg: `${Math.round(bg.r)},${Math.round(bg.g)},${Math.round(bg.b)}`,
        });
      }
      return out;
    });

    expect(results.length, "contrast selector set non-empty").toBeGreaterThan(
      0,
    );
    expect(results.length, "every selector sampled").toBe(5);
    for (const r of results) {
      expect(r.ratio, `${r.sel} missing element`).not.toBe(-1);
      expect(
        r.ratio,
        `${r.sel} contrast ${r.ratio.toFixed(2)} fg ${r.fg} bg ${r.bg} should be >=4.5`,
      ).toBeGreaterThanOrEqual(4.5);
    }
    expect(pageErrors).toEqual([]);
    expect(consoleEvents).toEqual([]);
  });

  test("disabled state has non-color cue", async ({ page }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
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
    expect(consoleEvents).toEqual([]);
  });
});

test.describe("browser-foundation – screenshots and preview", () => {
  for (const vp of viewports) {
    test(`screenshot smoke at ${vp.name}`, async ({ page }) => {
      const consoleEvents: { type: string; text: string }[] = [];
      const pageErrors: string[] = [];
      page.on("console", (m) => {
        consoleEvents.push({ type: m.type(), text: m.text() });
      });
      page.on("pageerror", (e) => pageErrors.push(e.message));
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(400);
      const buf = await page.screenshot({ fullPage: false });
      expect(buf.length).toBeGreaterThan(1000);
      expect(pageErrors).toEqual([]);
      expect(consoleEvents).toEqual([]);
    });
  }
  test("reduced motion disables animation/transition and keeps idle camera stable with zero errors", async ({
    page,
  }) => {
    const consoleEvents: { type: string; text: string }[] = [];
    const pageErrors: string[] = [];
    page.on("console", (m) => {
      consoleEvents.push({ type: m.type(), text: m.text() });
    });
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(600);

    const reducedState = await page.evaluate(() => {
      const bodyReduced = document.body.classList.contains("reduced-motion");
      const snap = (window as unknown as Record<string, unknown>)
        .__vibecoasterSnapshot as unknown as
        (() => Record<string, unknown>) | undefined;
      const snapReduced = snap
        ? (snap() as Record<string, unknown>).reducedMotion
        : null;
      const sample = document.querySelector(".btn") as HTMLElement;
      const cs = sample ? getComputedStyle(sample) : null;
      return {
        bodyReduced,
        snapReduced,
        animationDuration: cs?.animationDuration,
        transitionDuration: cs?.transitionDuration,
        animationName: cs?.animationName,
      };
    });
    expect(
      reducedState.bodyReduced,
      "body should have reduced-motion class",
    ).toBe(true);
    expect(reducedState.snapReduced, "snapshot reducedMotion true").toBe(true);
    // CSS animation and transition disabled (0s or 0.01ms)
    const isDisabled = (v: string | undefined) =>
      v === "0s" ||
      v === "0.01ms" ||
      v === "0ms" ||
      v === "0.01ms, 0.01ms" ||
      (v !== undefined && parseFloat(v) <= 0.02);
    expect(
      isDisabled(reducedState.animationDuration),
      `animationDuration disabled got ${reducedState.animationDuration}`,
    ).toBe(true);
    expect(
      isDisabled(reducedState.transitionDuration),
      `transitionDuration disabled got ${reducedState.transitionDuration}`,
    ).toBe(true);

    // idle camera motion remains stable when reduced – camera position should not drift
    const stability = await page.evaluate(async () => {
      const snapFn = (window as unknown as Record<string, unknown>)
        .__vibecoasterSnapshot as unknown as
        (() => Record<string, unknown>) | undefined;
      if (!snapFn) return { stable: false, reason: "no snapshot", dist: 999 };
      const a = snapFn() as Record<string, unknown>;
      await new Promise((r) => setTimeout(r, 600));
      const b = snapFn() as Record<string, unknown>;
      const dx = (a.cameraX as number) - (b.cameraX as number);
      const dy = (a.cameraY as number) - (b.cameraY as number);
      const dz = (a.cameraZ as number) - (b.cameraZ as number);
      const dist = Math.hypot(dx, dy, dz);
      return {
        stable: dist < 0.05,
        dist,
        aPos: [a.cameraX, a.cameraY, a.cameraZ],
        bPos: [b.cameraX, b.cameraY, b.cameraZ],
      };
    });
    expect(
      stability.stable,
      `idle camera should remain stable under reduced motion, drift ${stability.dist}`,
    ).toBe(true);

    expect(pageErrors, `page errors: ${pageErrors.join("; ")}`).toEqual([]);
    expect(
      consoleEvents,
      `console errors: ${JSON.stringify(consoleEvents)}`,
    ).toEqual([]);
  });
});
