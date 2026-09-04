import { expect, test } from "@playwright/test";
import { fileURLToPath, pathToFileURL } from "node:url";

const artifactPath = fileURLToPath(
  new URL("../../apps/web/dist/OpenVibeCoaster.html", import.meta.url),
);
const artifactFileUrl = pathToFileURL(artifactPath).href;

test.use({ launchOptions: { args: ["--disable-webgl"] } });

test("webkit portable stall probe from file://", async ({ page }) => {
  const startedWallMs = Date.now();
  const consoleEvents: Array<{ type: string; text: string }> = [];
  const pageErrors: string[] = [];
  const requestFailed: Array<{ url: string; failure: string }> = [];
  const responses: Array<{ url: string; status: number }> = [];
  const disallowedRequests: string[] = [];
  let gotoStartWallMs = 0;
  let gotoEndWallMs = 0;
  let clickWallMs = 0;
  let readyStartWallMs = 0;
  let readyEndWallMs = 0;
  let probeError: unknown = null;

  page.on("console", (message) => {
    consoleEvents.push({
      type: message.type(),
      text: message.text().slice(0, 1000),
    });
  });
  page.on("pageerror", (error) => {
    const message =
      error instanceof Error ? error.message : String(error ?? "pageerror");
    pageErrors.push(message.slice(0, 1000));
  });
  page.on("requestfailed", (request) => {
    requestFailed.push({
      url: request.url().slice(0, 500),
      failure: String(request.failure()?.errorText ?? "failed").slice(0, 500),
    });
  });
  page.on("response", (response) => {
    responses.push({
      url: response.url().slice(0, 500),
      status: response.status(),
    });
  });
  page.on("request", (request) => {
    const url = request.url();
    const allowed =
      url === artifactFileUrl ||
      url.startsWith("data:") ||
      url.startsWith("blob:");
    if (!allowed) {
      disallowedRequests.push(url.slice(0, 500));
    }
  });

  await page.addInitScript(() => {
    const g = window as unknown as Record<string, unknown>;
    if (g["__ovcWebkitProbeInstalled"]) {
      return;
    }
    g["__ovcWebkitProbeInstalled"] = true;
    const events: unknown[] = [];
    const heartbeats: unknown[] = [];
    g["__ovcWebkitProbeEvents"] = events;
    g["__ovcWebkitProbeHeartbeats"] = heartbeats;

    const now = (): { wall: number; perf: number } => {
      let perf = -1;
      try {
        perf = performance.now();
      } catch {
        perf = -1;
      }
      return { wall: Date.now(), perf };
    };

    const summarizeData = (data: unknown): Record<string, unknown> => {
      try {
        if (data === null || data === undefined) {
          return { kind: typeof data };
        }
        if (typeof data === "string") {
          return {
            kind: "string",
            length: data.length,
            head: data.slice(0, 120),
          };
        }
        if (typeof data === "object") {
          const rec = data as Record<string, unknown>;
          const out: Record<string, unknown> = {
            kind: Array.isArray(data) ? "array" : "object",
          };
          if (typeof rec["type"] === "string") {
            out["type"] = (rec["type"] as string).slice(0, 80);
          }
          if (typeof rec["requestId"] === "string") {
            out["requestId"] = (rec["requestId"] as string).slice(0, 120);
          }
          try {
            out["keys"] = Object.keys(rec).slice(0, 20);
          } catch {
            // ignore key enumeration failure
          }
          return out;
        }
        return { kind: typeof data };
      } catch {
        return { kind: "unknown" };
      }
    };

    const push = (entry: unknown): void => {
      try {
        events.push(entry);
      } catch {
        // never alter page behavior for probe recording
      }
    };

    push({
      kind: "init",
      ...now(),
      href: String(location.href).slice(0, 200),
      ua: String(navigator.userAgent).slice(0, 200),
    });

    const RealWorker = (window as unknown as { Worker?: unknown })[
      "Worker"
    ] as unknown as new (...args: never[]) => Worker;
    if (typeof RealWorker !== "function") {
      push({ kind: "no-worker", ...now() });
    } else {
      // Transparent wrapper: forwards constructor arguments, transfers,
      // and prototype semantics exactly; only records, never mutates.
      function ProbeWorker(
        this: unknown,
        ...ctorArgs: never[]
      ): unknown {
        if (new.target === undefined) {
          throw new TypeError(
            "Constructor Worker requires 'new' operator",
          );
        }
        let firstSummary: Record<string, unknown> = { kind: "none" };
        try {
          const first: unknown = ctorArgs[0];
          if (typeof first === "string") {
            firstSummary = {
              kind: "string",
              length: first.length,
              head: first.slice(0, 200),
            };
          } else if (first instanceof URL) {
            firstSummary = {
              kind: "URL",
              href: String(first.href).slice(0, 200),
            };
          } else if (first !== null && typeof first === "object") {
            firstSummary = { kind: "object" };
          } else {
            firstSummary = { kind: typeof first };
          }
        } catch {
          firstSummary = { kind: "unknown" };
        }
        push({
          kind: "constructor",
          ...now(),
          argsLength: ctorArgs.length,
          first: firstSummary,
        });
        const instance = Reflect.construct(
          RealWorker,
          ctorArgs,
          (new.target as unknown as new (...a: never[]) => Worker) ??
            (ProbeWorker as unknown as new (...a: never[]) => Worker),
        ) as Worker & Record<string, unknown>;
        try {
          instance.addEventListener("message", (ev: Event) => {
            try {
              const data = (ev as MessageEvent).data as unknown;
              push({ kind: "message", ...now(), data: summarizeData(data) });
            } catch {
              // ignore recording failure
            }
          });
        } catch {
          // ignore listener failure
        }
        try {
          instance.addEventListener("error", (ev: Event) => {
            try {
              const message =
                typeof (ev as ErrorEvent).message === "string"
                  ? (ev as ErrorEvent).message.slice(0, 500)
                  : String(ev).slice(0, 500);
              push({ kind: "error", ...now(), message });
            } catch {
              // ignore recording failure
            }
          });
        } catch {
          // ignore listener failure
        }
        try {
          instance.addEventListener("messageerror", () => {
            try {
              push({ kind: "messageerror", ...now() });
            } catch {
              // ignore recording failure
            }
          });
        } catch {
          // ignore listener failure
        }
        try {
          const origPostMessage = instance["postMessage"] as (
            ...args: never[]
          ) => void;
          Object.defineProperty(instance, "postMessage", {
            value: function (this: unknown, ...pmArgs: never[]) {
              try {
                const data: unknown = pmArgs[0];
                const transfer: unknown = pmArgs[1];
                let transferLength = -1;
                try {
                  if (Array.isArray(transfer)) {
                    transferLength = transfer.length;
                  }
                } catch {
                  transferLength = -1;
                }
                push({
                  kind: "postMessage",
                  ...now(),
                  data: summarizeData(data),
                  transferLength,
                });
              } catch {
                // ignore recording failure
              }
              return Reflect.apply(
                origPostMessage as (...a: never[]) => void,
                this,
                pmArgs,
              );
            },
            writable: true,
            configurable: true,
            enumerable: false,
          });
        } catch {
          // ignore wrapper failure, behavior unchanged
        }
        return instance;
      }
      try {
        const protoDesc = Object.getOwnPropertyDescriptor(
          RealWorker,
          "prototype",
        );
        if (protoDesc) {
          Object.defineProperty(ProbeWorker, "prototype", protoDesc);
        } else {
          (ProbeWorker as unknown as Record<string, unknown>)["prototype"] = (
            RealWorker as unknown as Record<string, unknown>
          )["prototype"];
        }
      } catch {
        try {
          (ProbeWorker as unknown as Record<string, unknown>)["prototype"] = (
            RealWorker as unknown as Record<string, unknown>
          )["prototype"];
        } catch {
          // ignore prototype preservation failure
        }
      }
      try {
        Object.setPrototypeOf(ProbeWorker, RealWorker);
      } catch {
        // ignore static inheritance failure
      }
      try {
        const nameDesc = Object.getOwnPropertyDescriptor(
          RealWorker,
          "name",
        );
        if (nameDesc) {
          Object.defineProperty(ProbeWorker, "name", nameDesc);
        }
      } catch {
        // ignore name preservation failure
      }
      try {
        const lengthDesc = Object.getOwnPropertyDescriptor(
          RealWorker,
          "length",
        );
        if (lengthDesc) {
          Object.defineProperty(ProbeWorker, "length", lengthDesc);
        }
      } catch {
        // ignore length preservation failure
      }
      (window as unknown as { Worker: unknown })["Worker"] =
        ProbeWorker as unknown;
    }

    try {
      const sample = (): void => {
        try {
          const el = document.querySelector("#status");
          heartbeats.push({
            ...now(),
            state: el ? el.getAttribute("data-state") : null,
            text: el ? String(el.textContent ?? "").slice(0, 200) : null,
          });
        } catch {
          // ignore heartbeat failure
        }
      };
      window.setInterval(sample, 1000);
      if (document.readyState !== "loading") {
        sample();
      } else {
        document.addEventListener("DOMContentLoaded", sample, { once: true });
      }
    } catch {
      // ignore heartbeat setup failure
    }
  });

  try {
    gotoStartWallMs = Date.now();
    await page.goto(artifactFileUrl, {
      waitUntil: "domcontentloaded",
    });
    gotoEndWallMs = Date.now();

    await expect(page.locator("#generate-btn")).toBeVisible();
    await expect(page.locator("#seed-input")).toBeEnabled();
    await page.locator("#seed-input").fill("1337");
    clickWallMs = Date.now();
    await page.locator("#generate-btn").click();
    readyStartWallMs = Date.now();
    // realistic engineering bound: 90s as per acceptance-helpers
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "ready",
      {
        timeout: 90_000,
      },
    );
    readyEndWallMs = Date.now();
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

    const consoleErrors = consoleEvents
      .filter((entry) => entry.type === "error")
      .map((entry) => entry.text);
    expect(
      disallowedRequests,
      `disallowed requests (only ${artifactFileUrl} plus data: and blob: allowed): ${disallowedRequests.join(", ")}`,
    ).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } catch (error) {
    probeError = error;
    throw error;
  } finally {
    try {
      const snapshot = await page.evaluate(() => {
        const w = window as unknown as Record<string, unknown>;
        const readArray = (key: string, limit: number): unknown[] => {
          try {
            const value = w[key];
            if (Array.isArray(value)) {
              return (value as unknown[]).slice(0, limit);
            }
            return [];
          } catch {
            return [];
          }
        };
        const workerEvents = readArray("__ovcWebkitProbeEvents", 500);
        const heartbeats = readArray("__ovcWebkitProbeHeartbeats", 200);
        let measures: unknown[] = [];
        let marks: unknown[] = [];
        try {
          measures = performance
            .getEntriesByType("measure")
            .filter((entry) => entry.name.startsWith("ovc:"))
            .map((entry) => ({
              name: entry.name,
              startTime: (entry as PerformanceEntry).startTime,
              duration: (entry as PerformanceEntry).duration,
            }))
            .slice(0, 50);
          marks = performance
            .getEntriesByType("mark")
            .filter((entry) => entry.name.startsWith("ovc:"))
            .map((entry) => ({
              name: entry.name,
              startTime: (entry as PerformanceEntry).startTime,
            }))
            .slice(0, 50);
        } catch {
          measures = [];
          marks = [];
        }
        let navigations: unknown[] = [];
        try {
          navigations = performance
            .getEntriesByType("navigation")
            .map((entry) => {
              const nav = entry as PerformanceNavigationTiming;
              return {
                type: nav.type,
                startTime: nav.startTime,
                duration: nav.duration,
                domContentLoaded: nav.domContentLoadedEventEnd,
                load: nav.loadEventEnd,
              };
            })
            .slice(0, 5);
        } catch {
          navigations = [];
        }
        let timeOrigin = -1;
        let perfNow = -1;
        try {
          timeOrigin = performance.timeOrigin;
        } catch {
          timeOrigin = -1;
        }
        try {
          perfNow = performance.now();
        } catch {
          perfNow = -1;
        }
        const statusEl = document.querySelector("#status");
        const checksumEl = document.querySelector(
          '[data-testid="compiled-checksum"]',
        );
        const lengthEl = document.querySelector(
          '[data-testid="track-length"]',
        );
        return {
          workerEvents,
          heartbeats,
          measures,
          marks,
          navigations,
          timeOrigin,
          perfNow,
          readyState: document.readyState,
          statusState: statusEl
            ? statusEl.getAttribute("data-state")
            : null,
          statusText: statusEl
            ? String(statusEl.textContent ?? "").slice(0, 500)
            : null,
          checksum:
            checksumEl?.getAttribute("data-checksum") ??
            checksumEl?.getAttribute("data-compiled-checksum") ??
            null,
          lengthM: lengthEl?.getAttribute("data-length-m") ?? null,
          userAgent: String(navigator.userAgent).slice(0, 300),
          href: String(location.href).slice(0, 300),
        };
      });
      const failureMessage =
        probeError instanceof Error
          ? probeError.message.slice(0, 1000)
          : probeError === null
            ? null
            : String(probeError).slice(0, 1000);
      const diagnostic = {
        marker: "ovc-webkit-probe",
        seed: 1337,
        artifactFileUrl,
        startedWallMs,
        gotoStartWallMs,
        gotoEndWallMs,
        clickWallMs,
        readyStartWallMs,
        readyEndWallMs,
        elapsedWallMs: Date.now() - startedWallMs,
        failureMessage,
        disallowedRequests: disallowedRequests.slice(0, 50),
        pageErrors: pageErrors.slice(0, 50),
        consoleEvents: consoleEvents.slice(0, 200),
        requestFailed: requestFailed.slice(0, 50),
        responses: responses.slice(0, 50),
        workerEvents: snapshot.workerEvents,
        heartbeats: snapshot.heartbeats,
        ovcMeasures: snapshot.measures,
        ovcMarks: snapshot.marks,
        navigations: snapshot.navigations,
        timeOrigin: snapshot.timeOrigin,
        perfNow: snapshot.perfNow,
        readyState: snapshot.readyState,
        statusState: snapshot.statusState,
        statusText: snapshot.statusText,
        checksum: snapshot.checksum,
        lengthM: snapshot.lengthM,
        userAgent: snapshot.userAgent,
        href: snapshot.href,
      };
      console.log(
        `OVC_WEBKIT_PROBE_DIAGNOSTIC ${JSON.stringify(diagnostic)}`,
      );
    } catch (snapshotError) {
      const fallbackMessage =
        snapshotError instanceof Error
          ? snapshotError.message.slice(0, 500)
          : String(snapshotError ?? "snapshot failed").slice(0, 500);
      console.log(
        `OVC_WEBKIT_PROBE_DIAGNOSTIC ${JSON.stringify({
          marker: "ovc-webkit-probe",
          seed: 1337,
          snapshotFailed: fallbackMessage,
          startedWallMs,
          consoleEvents: consoleEvents.slice(0, 50),
          pageErrors: pageErrors.slice(0, 20),
          requestFailed: requestFailed.slice(0, 20),
          responses: responses.slice(0, 20),
          disallowedRequests: disallowedRequests.slice(0, 20),
        })}`,
      );
    }
  }
});
