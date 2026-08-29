import { describe, it, expect } from "vitest";
import { build } from "vite";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
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
  it("Vite 8.2.2 inline production build is self-contained Blob/data URL, no asset/fetch, exact URL lifecycle", async () => {
    const testFile = fileURLToPath(import.meta.url);
    const projectRoot = join(dirname(testFile), "../..");
    const tempDir = await mkdtemp(join(tmpdir(), "vibe-inline-"));
    const entryPath = join(tempDir, "entry.ts");
    const outDir = join(tempDir, "dist");
    const capture: {
      blob?: Blob;
      createdUrl?: string;
      revokedUrl?: string;
      workerUrl?: string;
    } = {};
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    const originalWorker = (globalThis as unknown as { Worker?: unknown })
      .Worker;
    const originalFetch = globalThis.fetch;
    const originalSelf = (globalThis as unknown as { self?: unknown }).self;

    let errorHandler: EventListener | undefined;

    try {
      await writeFile(
        entryPath,
        `
import { createEngineeringWorker } from "${projectRoot.replace(/\\/g, "/")}/src/engineering/factory.ts";
const w = createEngineeringWorker();
w.postMessage({type:"ping"});
w.terminate();
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
      expect(
        all.some(
          (f) => f.toLowerCase().includes("worker") && !f.includes("entry"),
        ),
      ).toBe(false);

      const entryFile = jsFiles[0]!;
      const code = readFileSync(join(outDir, entryFile), "utf8");
      expect(code.includes("Worker")).toBe(true);
      const hasBlob = code.includes("Blob");
      const hasData = code.includes("data:");
      expect(hasBlob || hasData).toBe(true);
      if (hasBlob) {
        expect(code.includes("createObjectURL") || code.includes("Blob")).toBe(
          true,
        );
      }
      expect(code.includes("/assets/worker")).toBe(false);
      expect(code.includes("/assets/")).toBe(false);

      // Polyfill self for Node so Blob branch is exercised
      (globalThis as unknown as { self: unknown }).self = globalThis;

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
          addEventListener: (type: string, listener: EventListener) => {
            if (type === "error") errorHandler = listener;
          },
          removeEventListener: () => {},
        } as unknown as Worker;
      } as unknown as typeof Worker;
      (globalThis as unknown as { Worker: unknown }).Worker = MockWorker;

      const builtUrl = pathToFileURL(join(outDir, entryFile)).href;
      await import(builtUrl);

      expect(capture.workerUrl).toBeDefined();
      expect(
        String(capture.workerUrl).startsWith("http://") ||
          String(capture.workerUrl).startsWith("https://"),
      ).toBe(false);
      expect(String(capture.workerUrl).includes("/assets/worker")).toBe(false);

      const isBlobMode =
        capture.blob !== undefined || capture.createdUrl !== undefined;
      if (isBlobMode) {
        // Vite wrapper revokes on error; trigger it to prove lifecycle
        if (errorHandler) {
          try {
            errorHandler(new Event("error"));
          } catch {}
        }
        expect(capture.blob).toBeDefined();
        expect(capture.blob!.size).toBeGreaterThan(0);
        expect(capture.createdUrl).toBeDefined();
        expect(capture.revokedUrl).toBeDefined();
        expect(capture.createdUrl).toBe(capture.workerUrl);
        expect(capture.revokedUrl).toBe(capture.createdUrl);
        expect(capture.revokedUrl).toBe(capture.workerUrl);
      } else {
        expect(hasData).toBe(true);
        expect(capture.blob).toBeUndefined();
        expect(capture.createdUrl).toBeUndefined();
        expect(capture.revokedUrl).toBeUndefined();
        expect(String(capture.workerUrl).startsWith("data:")).toBe(true);
      }
    } finally {
      (globalThis as unknown as { Worker?: unknown }).Worker = originalWorker;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
      if (originalSelf === undefined) {
        delete (globalThis as unknown as { self?: unknown }).self;
      } else {
        (globalThis as unknown as { self: unknown }).self = originalSelf;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  }, 30000);
});
