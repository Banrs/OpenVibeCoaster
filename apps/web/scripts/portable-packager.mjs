import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PORTABLE_WORKER_INVARIANT =
  "Future production workers must be Vite-inlined and Blob-backed so the portable output remains a single-file artifact.";

const threeEntry = fileURLToPath(import.meta.resolve("three"));
const threeLicense = readFileSync(
  resolve(dirname(threeEntry), "../LICENSE"),
  "utf8",
).trim();
const thirdPartyNotice = `<!--
Third-party license: three.js

${threeLicense}
-->`;

function attribute(tag, name) {
  const match = tag.match(
    new RegExp(
      `(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i",
    ),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function isWithinDirectory(directory, candidate) {
  const fromDirectory = relative(directory, candidate);
  return (
    fromDirectory !== "" &&
    fromDirectory !== ".." &&
    !fromDirectory.startsWith(`..\\`) &&
    !fromDirectory.startsWith(`../`) &&
    !isAbsolute(fromDirectory)
  );
}

function resolveAsset(distDir, reference) {
  if (!reference) {
    throw new Error("Portable asset reference must be a local relative path");
  }

  const rawPath = reference.split(/[?#]/, 1)[0];
  if (
    !rawPath ||
    rawPath.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(reference) ||
    rawPath.includes("\\")
  ) {
    throw new Error(
      `Portable asset reference must be local relative path: ${reference}`,
    );
  }

  let decodedPath;
  try {
    decodedPath = decodeURIComponent(rawPath);
  } catch {
    throw new Error(`Portable asset reference is not valid: ${reference}`);
  }
  if (decodedPath.startsWith("/") || decodedPath.startsWith("\\")) {
    throw new Error(
      `Portable asset reference must be local relative path: ${reference}`,
    );
  }
  if (decodedPath.split(/[\\/]/).includes("..")) {
    throw new Error(`Portable asset reference is outside dist: ${reference}`);
  }
  if (decodedPath.includes("\\")) {
    throw new Error(
      `Portable asset reference must be local relative path: ${reference}`,
    );
  }

  const distRealPath = realpathSync(distDir);
  const candidate = resolve(distRealPath, decodedPath);
  let assetRealPath;
  try {
    assetRealPath = realpathSync(candidate);
  } catch {
    throw new Error(`Portable asset does not exist in dist: ${reference}`);
  }
  if (!isWithinDirectory(distRealPath, assetRealPath)) {
    throw new Error(`Portable asset is outside dist: ${reference}`);
  }
  return assetRealPath;
}

function escapeInlineText(text, element) {
  return text.replace(new RegExp(`</${element}`, "gi"), `<\\/${element}`);
}

function withoutScriptSourceAttributes(attributes) {
  return attributes
    .replace(
      /\s+(?:src|crossorigin|integrity)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi,
      "",
    )
    .replace(/\s+crossorigin(?=\s|$)/gi, "")
    .trim();
}

function inlineStyles(html, distDir) {
  return html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = attribute(tag, "rel");
    if (!rel || !rel.split(/\s+/).includes("stylesheet")) {
      return tag;
    }
    const href = attribute(tag, "href");
    const css = readFileSync(resolveAsset(distDir, href), "utf8");
    const media = attribute(tag, "media");
    return `<style${media ? ` media="${media.replaceAll('"', "&quot;")}"` : ""}>${escapeInlineText(css, "style")}</style>`;
  });
}

function inlineScripts(html, distDir) {
  return html.replace(
    /<script\b([^>]*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)[^>]*)>([\s\S]*?)<\/script\s*>/gi,
    (match, attributes, _body) => {
      const src = attribute(attributes, "src");
      const javascript = readFileSync(resolveAsset(distDir, src), "utf8");
      const retainedAttributes = withoutScriptSourceAttributes(attributes);
      return `<script${retainedAttributes ? ` ${retainedAttributes}` : ""}>${escapeInlineText(javascript, "script")}</script>`;
    },
  );
}

function includeThirdPartyNotice(html) {
  const doctype = /<!doctype html>/i;
  return doctype.test(html)
    ? html.replace(doctype, (match) => `${match}\n${thirdPartyNotice}`)
    : `${thirdPartyNotice}\n${html}`;
}

export function createPortableHtml({ distDir, inputFile, outputFile }) {
  const html = readFileSync(inputFile, "utf8");
  const withStyles = inlineStyles(html, distDir);
  const portableHtml = includeThirdPartyNotice(
    inlineScripts(withStyles, distDir),
  );
  writeFileSync(outputFile, portableHtml, "utf8");
  return portableHtml;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const distDir = resolve(dirname(scriptPath), "../dist");
  createPortableHtml({
    distDir,
    inputFile: resolve(distDir, "index.html"),
    outputFile: resolve(distDir, "OpenVibeCoaster.html"),
  });
}
