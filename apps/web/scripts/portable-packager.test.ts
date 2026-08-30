import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPortableHtml } from "./portable-packager.mjs";

function createFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "openvibecoaster-portable-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(
    join(root, "index.html"),
    `<!doctype html>
<html><head><link rel="stylesheet" href="./assets/site.css"></head>
<body><script type="module" src="./assets/app.js"></script></body></html>`,
  );
  writeFileSync(
    join(root, "assets", "site.css"),
    'body::before{content:"</style>"}',
  );
  writeFileSync(
    join(root, "assets", "app.js"),
    'globalThis.portableMarker = "</script>";',
  );
  return root;
}

describe("portable HTML packager", () => {
  it("inlines local CSS and JavaScript deterministically", () => {
    const root = createFixture();
    try {
      const outputFile = join(root, "OpenVibeCoaster.html");
      const first = createPortableHtml({
        distDir: root,
        inputFile: join(root, "index.html"),
        outputFile,
      });
      const second = createPortableHtml({
        distDir: root,
        inputFile: join(root, "index.html"),
        outputFile,
      });

      expect(first).toBe(second);
      expect(first).toContain("<style>");
      expect(first).toContain('<script type="module">');
      expect(first).not.toMatch(/<link[^>]+rel=["']stylesheet["'][^>]*>/i);
      expect(first).not.toMatch(/<script[^>]+src=["'][^"']+["'][^>]*>/i);
      expect(first).toContain("<\\/style>");
      expect(first).toContain("<\\/script>");
      expect(readFileSync(outputFile, "utf8")).toBe(first);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["missing asset", "./assets/missing.css", /does not exist/],
    ["traversal asset", "../outside.css", /outside dist/],
    ["absolute asset", "file:///outside.css", /local relative/],
    ["browser-root asset", "/assets/app.js", /local relative/],
    ["encoded browser-root asset", "%2Fassets/app.js", /local relative/],
    [
      "encoded backslash traversal",
      "assets%5C..%5C..%5Coutside.css",
      /outside dist|local relative/,
    ],
    ["encoded leading backslash", "%5Cassets/app.js", /local relative/],
    [
      "encoded backslash traversal mixed",
      "assets%5c..%2f..%5c..%5coutside.css",
      /outside dist|local relative/,
    ],
  ])("rejects %s references", (_label, reference, error) => {
    const root = createFixture();
    try {
      const inputFile = join(root, "index.html");
      writeFileSync(
        inputFile,
        `<link rel="stylesheet" href="${reference}"><script src="./assets/app.js"></script>`,
      );

      expect(() =>
        createPortableHtml({
          distDir: root,
          inputFile,
          outputFile: join(root, "OpenVibeCoaster.html"),
        }),
      ).toThrow(error);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps the future worker invariant explicit", async () => {
    const source = await import("./portable-packager.mjs");
    expect(source.PORTABLE_WORKER_INVARIANT).toMatch(
      /Vite-inlined.*Blob-backed.*single-file/i,
    );
  });
});
