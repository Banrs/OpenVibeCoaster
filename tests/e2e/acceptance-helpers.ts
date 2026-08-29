import { expect, type Page } from "@playwright/test";

export interface Observability {
  consoleErrors: string[];
  consoleAll: { type: string; text: string }[];
  pageErrors: string[];
  externalRequests: string[];
  fetchCalls: string[];
}

export function attachObservability(page: Page): Observability {
  const obs: Observability = {
    consoleErrors: [],
    consoleAll: [],
    pageErrors: [],
    externalRequests: [],
    fetchCalls: [],
  };
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    obs.consoleAll.push({ type, text });
    if (type === "error") obs.consoleErrors.push(text);
  });
  page.on("pageerror", (err) => obs.pageErrors.push(err.message));
  page.on("request", (req) => {
    const url = req.url();
    if (/^(?:https?:|wss?:)/i.test(url)) obs.externalRequests.push(url);
    // detect runtime fetch to http(s) – even same-origin fetch would be http; data/file are ignored
    if (req.resourceType() === "fetch" || req.resourceType() === "xhr") {
      if (/^(?:https?:)/i.test(url)) obs.fetchCalls.push(url);
    }
  });
  return obs;
}

export function assertNoObservability(
  obs: Observability,
  context: string,
): void {
  expect(
    obs.pageErrors,
    `${context} pageErrors: ${obs.pageErrors.join("; ")}`,
  ).toEqual([]);
  expect(
    obs.consoleErrors,
    `${context} console errors: ${JSON.stringify(obs.consoleAll)}`,
  ).toEqual([]);
  expect(
    obs.externalRequests,
    `${context} external requests: ${obs.externalRequests.join("; ")}`,
  ).toEqual([]);
  expect(
    obs.fetchCalls,
    `${context} runtime fetch: ${obs.fetchCalls.join("; ")}`,
  ).toEqual([]);
}

export async function waitForReady(
  page: Page,
  timeout = 30_000,
): Promise<void> {
  const status = page.locator("#status");
  await expect(status).toHaveAttribute("data-state", "ready", { timeout });
  await expect(status.locator(".status-text")).toContainText("Ready", {
    timeout: 5_000,
  });
}

export async function waitForNonReadyError(
  page: Page,
  timeout = 30_000,
): Promise<void> {
  const status = page.locator("#status");
  await expect(status).toHaveAttribute("data-state", "error", { timeout });
}

export async function enableInstaGenerate(page: Page): Promise<void> {
  await page.locator("#generation-insta").click();
  // ensure stall remains required (directed success needs stall) but insta default stall is checked
  const stall = page.locator("#required-stall");
  if (!(await stall.isChecked())) await stall.check();
  // ensure top-hat optionally checked to force element count + height
  const topHat = page.locator("#required-top-hat");
  if (!(await topHat.isChecked())) await topHat.check();
}

export async function fillSeed(page: Page, seed = "1337"): Promise<void> {
  const input = page.locator("#seed-input");
  await input.click();
  await input.fill(seed);
  await input.press("Tab");
}

// Read track-length from DOM contract where available; fallback tries several selectors
export async function readTrackLength(page: Page): Promise<number | null> {
  const selectors = [
    '[data-testid="track-length"]',
    "[data-track-length]",
    "#track-length",
    '[data-testid="total-length"]',
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    const text = await loc.textContent();
    if (!text) continue;
    const num = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
    if (Number.isFinite(num)) return num;
    const attr = await loc.getAttribute("data-track-length");
    if (attr && Number.isFinite(Number.parseFloat(attr)))
      return Number.parseFloat(attr);
    const dataVal = await loc.getAttribute("data-value");
    if (dataVal && Number.isFinite(Number.parseFloat(dataVal)))
      return Number.parseFloat(dataVal);
  }
  // try diagnostics or element readout containing length
  const diag = await page.locator("#diagnostics-list").textContent();
  if (diag) {
    const m = diag.match(/(\d{3,4}(?:\.\d+)?)\s*m/);
    if (m) return Number.parseFloat(m[1]!);
  }
  return null;
}

export async function readTimelineDuration(page: Page): Promise<number | null> {
  const selectors = [
    '[data-testid="timeline-duration"]',
    "[data-timeline-duration]",
    "#timeline-duration",
    ".scrubber-value",
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    const text = await loc.textContent();
    if (!text) continue;
    // scrubber-value is "X / 1000" – need duration not index
    const attr = await loc.getAttribute("data-duration");
    if (attr && Number.isFinite(Number.parseFloat(attr)))
      return Number.parseFloat(attr);
    const num = Number.parseFloat(text);
    if (Number.isFinite(num) && sel !== ".scrubber-value") return num;
  }
  return null;
}

export async function noHorizontalOverflow(
  page: Page,
  viewportName: string,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const docScroll = document.documentElement.scrollWidth;
    const docClient = document.documentElement.clientWidth;
    const topBar = document.getElementById("top-bar") as HTMLElement | null;
    const topScroll = topBar ? topBar.scrollWidth : 0;
    const topClient = topBar ? topBar.clientWidth : 0;
    return { docScroll, docClient, topScroll, topClient };
  });
  expect(
    overflow.docScroll,
    `doc scroll ${overflow.docScroll} <= client ${overflow.docClient} at ${viewportName}`,
  ).toBeLessThanOrEqual(overflow.docClient + 1);
  expect(
    overflow.topScroll,
    `top-bar scroll ${overflow.topScroll} <= client ${overflow.topClient} at ${viewportName}`,
  ).toBeLessThanOrEqual(overflow.topClient + 1);
}

export function parseCoasterFileV1FromBytes(text: string): unknown {
  return JSON.parse(text) as unknown;
}

export function validateCoasterFileV1SchemaFields(payload: unknown): string[] {
  const errors: string[] = [];
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload)
  ) {
    errors.push("payload must be object");
    return errors;
  }
  const rec = payload as Record<string, unknown>;
  const required = [
    "schemaVersion",
    "name",
    "intent",
    "solvedSpans",
    "seed",
    "generatorVersion",
    "profileVersion",
    "researchSnapshotIds",
    "compiledDataChecksum",
  ];
  for (const key of required) if (!(key in rec)) errors.push(`missing ${key}`);
  if (rec.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (typeof rec.name !== "string") errors.push("name must be string");
  if (!Array.isArray(rec.solvedSpans)) errors.push("solvedSpans must be array");
  if (typeof rec.seed !== "number") errors.push("seed must be number");
  if (typeof rec.generatorVersion !== "string")
    errors.push("generatorVersion must be string");
  if (typeof rec.profileVersion !== "string")
    errors.push("profileVersion must be string");
  if (!Array.isArray(rec.researchSnapshotIds))
    errors.push("researchSnapshotIds must be array");
  if (
    typeof rec.compiledDataChecksum !== "string" ||
    !/^[0-9a-f]{8}$/i.test(rec.compiledDataChecksum as string)
  )
    errors.push("compiledDataChecksum must be 8 hex");
  // intent checks
  const intent = rec.intent as Record<string, unknown> | undefined;
  if (intent) {
    if (intent.schemaVersion !== 1)
      errors.push("intent.schemaVersion must be 1");
    if (!Array.isArray(intent.elements))
      errors.push("intent.elements must be array");
    if (!Array.isArray(intent.gates)) errors.push("intent.gates must be array");
  }
  return errors;
}
