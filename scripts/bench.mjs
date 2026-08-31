#!/usr/bin/env node
/**
 * Root bench orchestrator – runs engineering benchmark plus production Chromium browser benchmark.
 * Covers p50/p95 for generation (candidateSearchInclusive/searchOverhead/solving/compilation/validation/total)
 * and browser simulation / worker transfer / initial mesh creation / steady-state 1080p frame time.
 * Preserves honest target misses – never swallows non-zero exits.
 * Cross-platform: uses Node child_process, no shell-specific syntax.
 */
import { spawn } from "node:child_process";

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: false,
      ...opts,
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  console.log("bench: starting engineering benchmark (bench:engineering)...");
  const engCode = await run("npm", ["run", "bench:engineering"], {
    env: process.env,
  });
  if (engCode !== 0) {
    console.error(`bench: engineering benchmark failed with code ${engCode}`);
    process.exit(engCode);
  }
  console.log(
    "bench: engineering passed – starting browser benchmark (bench:browser, Chromium production preview)...",
  );
  const browserCode = await run("npm", ["run", "bench:browser"], {
    env: process.env,
  });
  if (browserCode !== 0) {
    console.error(`bench: browser benchmark failed with code ${browserCode}`);
    process.exit(browserCode);
  }
  console.log(
    "bench: complete – engineering + browser (Chromium production) passed.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
