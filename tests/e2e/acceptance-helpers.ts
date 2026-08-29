import { expect, type Page } from "@playwright/test";

export interface Observability {
  consoleErrors: string[];
  consoleAll: { type: string; text: string }[];
  pageErrors: string[];
  crossOriginRequests: string[];
  fetchCalls: string[];
}

const PREVIEW_ORIGIN = "http://127.0.0.1:4173";

function isCrossOrigin(url: string): boolean {
  try {
    const u = new URL(url);
    if (
      u.protocol === "file:" ||
      u.protocol === "data:" ||
      u.protocol === "blob:"
    )
      return false;
    return u.origin !== PREVIEW_ORIGIN;
  } catch {
    return false;
  }
}

export function attachObservability(page: Page): Observability {
  const obs: Observability = {
    consoleErrors: [],
    consoleAll: [],
    pageErrors: [],
    crossOriginRequests: [],
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
    if (isCrossOrigin(url)) obs.crossOriginRequests.push(url);
    if (req.resourceType() === "fetch" || req.resourceType() === "xhr") {
      obs.fetchCalls.push(url);
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
    obs.crossOriginRequests,
    `${context} cross-origin: ${obs.crossOriginRequests.join("; ")}`,
  ).toEqual([]);
  expect(
    obs.fetchCalls,
    `${context} runtime fetch/XHR: ${obs.fetchCalls.join("; ")}`,
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

export async function gotoAndGenerateInsta(
  page: Page,
  seed = "1337",
): Promise<void> {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  await page.locator("#generation-insta").click();
  const stall = page.locator("#required-stall");
  if (!(await stall.isChecked())) await stall.check();
  const topHat = page.locator("#required-top-hat");
  if (!(await topHat.isChecked())) await topHat.check();
  const input = page.locator("#seed-input");
  await input.click();
  await input.fill(seed);
  await page.locator("#generate-btn").click();
  await waitForReady(page, 30_000);
}

export async function waitForRAF(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r())),
      ),
  );
}

export async function noHorizontalOverflow(
  page: Page,
  viewportName: string,
): Promise<void> {
  const overflow = await page.evaluate(() => {
    const docScroll = document.documentElement.scrollWidth;
    const docClient = document.documentElement.clientWidth;
    const topBar = document.getElementById("top-bar") as HTMLElement | null;
    return {
      docScroll,
      docClient,
      topScroll: topBar ? topBar.scrollWidth : 0,
      topClient: topBar ? topBar.clientWidth : 0,
    };
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
  if (typeof rec.seed !== "number" || !Number.isInteger(rec.seed))
    errors.push("seed must be integer");
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
  const intent = rec.intent as Record<string, unknown> | undefined;
  if (intent) {
    if (intent.schemaVersion !== 1)
      errors.push("intent.schemaVersion must be 1");
    if (!Array.isArray(intent.elements))
      errors.push("intent.elements must be array");
    if (!Array.isArray(intent.gates)) errors.push("intent.gates must be array");
    if (!Array.isArray(intent.targets))
      errors.push("intent.targets must be array");
  }
  return errors;
}
