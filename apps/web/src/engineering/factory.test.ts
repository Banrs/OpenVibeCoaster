import { describe, it, expect } from "vitest";
import { build } from "vite";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readdirSync, readFileSync } from "fs";

function listFiles(dir: string, prefix = ""): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  let out: string[] = [];
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, prefix + e.name + "/"));
    else out.push(prefix + e.name);
  }
  return out;
}

describe("Vite ?worker&inline factory transform/runtime", () => {
  it("Vite 8.2.2 inline transform supplies self-contained Blob/data URL, no asset, no fetch", async () => {
    const testFile = fileURLToPath(import.meta.url);
    const projectRoot = join(dirname(testFile), "../..");
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-inline-"));
    const entryPath = join(tempDir, "entry.ts");
    const outDir = join(tempDir, "dist");
    try {
      await writeFile(
        entryPath,
        `
import { createEngineeringWorker } from "${projectRoot.replace(/\\/g, "/")}/src/engineering/factory.ts";
const w = createEngineeringWorker();
w.postMessage({type:"ping"});
w.terminate();
const w2 = createEngineeringWorker();
w2.terminate();
export {};
`,
        "utf8",
      );

      await build({
        root: projectRoot,
        configFile: false,
        logLevel: "silent",
        build: {
          outDir,
          emptyOutDir: true,
          write: true,
          target: "es2023",
          minify: false,
          rollupOptions: {
            input: entryPath,
          },
        },
      });

      const all = listFiles(outDir);
      const jsFiles = all.filter((f) => f.endsWith(".js"));
      expect(jsFiles).toHaveLength(1);
      const hasWorkerAsset = all.some(
        (f) => f.toLowerCase().includes("worker") && !f.includes("entry"),
      );
      expect(hasWorkerAsset).toBe(false);

      const entryFile = jsFiles[0]!;
      const code = readFileSync(join(outDir, entryFile), "utf8");

      const hasBlob = code.includes("Blob");
      const hasCreateObjectURL = code.includes("createObjectURL");
      const hasRevoke = code.includes("revokeObjectURL");
      const hasDataUrl = code.includes("data:");
      const hasWorker = code.includes("Worker");

      expect(hasWorker).toBe(true);
      expect(hasBlob || hasDataUrl).toBe(true);
      if (hasBlob) {
        expect(hasCreateObjectURL).toBe(true);
        expect(hasRevoke).toBe(true);
        expect(code.length).toBeGreaterThan(1000);
        expect(code.includes("new Worker")).toBe(true);
        const workerIdx = code.indexOf("new Worker");
        const revokeIdx = code.indexOf("revokeObjectURL");
        expect(workerIdx).toBeGreaterThan(-1);
        expect(revokeIdx).toBeGreaterThan(-1);
      } else {
        expect(hasDataUrl).toBe(true);
      }
      expect(code.includes("/assets/worker")).toBe(false);
      expect(code.includes("/assets/")).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);

  it("factory creates worker without network and terminates cleanly (runtime sanity)", async () => {
    const capture: {
      blob?: Blob;
      createdUrl?: string;
      revokedUrl?: string;
      workerUrl?: string;
    } = {};
    const originalWorker = (globalThis as unknown as { Worker?: unknown })
      .Worker;
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalFetch = globalThis.fetch;

    try {
      URL.createObjectURL = ((blob: Blob | MediaSource): string => {
        if (blob instanceof Blob) capture.blob = blob;
        const url = originalCreate.call(URL, blob as Blob);
        capture.createdUrl = url;
        return url;
      }) as unknown as typeof URL.createObjectURL;

      URL.revokeObjectURL = ((url: string): void => {
        capture.revokedUrl = url;
        return originalRevoke.call(URL, url);
      }) as unknown as typeof URL.revokeObjectURL;

      (globalThis as unknown as { fetch: unknown }).fetch = (async () => {
        throw new Error("fetch should not be called for inline worker");
      }) as unknown as typeof fetch;

      const MockWorker = function (this: unknown, url: string | URL) {
        capture.workerUrl = String(url);
        return {
          postMessage: () => {},
          terminate: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        } as unknown as Worker;
      } as unknown as typeof Worker;
      (globalThis as unknown as { Worker: unknown }).Worker = MockWorker;

      const { createEngineeringWorker } = await import("./factory");
      const w = createEngineeringWorker();
      expect(w).toHaveProperty("postMessage");
      expect(w).toHaveProperty("terminate");
      expect(capture.workerUrl).toBeDefined();
      expect(
        String(capture.workerUrl).startsWith("http://") ||
          String(capture.workerUrl).startsWith("https://"),
      ).toBe(false);
      if (capture.blob) {
        expect(capture.blob.size).toBeGreaterThan(0);
        expect(capture.createdUrl).toBe(capture.workerUrl);
        expect(capture.revokedUrl).toBeUndefined();
        w.terminate();
        expect(capture.revokedUrl).toBe(capture.createdUrl);
      } else if (capture.createdUrl) {
        expect(capture.createdUrl).toBe(capture.workerUrl);
        w.terminate();
        expect(capture.revokedUrl).toBe(capture.createdUrl);
      } else {
        const urlStr = String(capture.workerUrl);
        expect(
          urlStr.includes("&inline") ||
            urlStr.startsWith("data:") ||
            urlStr.includes("worker"),
        ).toBe(true);
        expect(urlStr.includes("/assets/worker")).toBe(false);
        w.terminate();
        expect(capture.revokedUrl).toBeUndefined();
      }
    } finally {
      (globalThis as unknown as { Worker?: unknown }).Worker = originalWorker;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    }
  });
});
