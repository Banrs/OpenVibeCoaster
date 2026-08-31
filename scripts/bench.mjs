#!/usr/bin/env node
/**
 * Root bench orchestrator – runs engineering benchmark plus production Chromium browser benchmark.
 * Covers p50/p95 for generation (candidateSearchInclusive/solving/compilation/validation/total)
 * and browser simulation / worker transfer / initial mesh creation / steady-state 1080p frame time.
 * Preserves honest target misses – never swallows non-zero exits.
 * Cross-platform: uses Node child_process, no shell-specific syntax.
 * Portable npm spawn: uses process.execPath + npm_execpath when present, with win32 npm.cmd fallback.
 */
import { spawn } from "node:child_process";

export function getNpmSpawnInfo({
  platform = process.platform,
  env = process.env,
  execPath = process.execPath,
} = {}) {
  const npmExecPath = env.npm_execpath;
  if (typeof npmExecPath === "string" && npmExecPath.length > 0) {
    return { command: execPath, argsPrefix: [npmExecPath] };
  }
  if (platform === "win32") {
    return { command: "npm.cmd", argsPrefix: [] };
  }
  return { command: "npm", argsPrefix: [] };
}

function runNpm(args, opts = {}) {
  const { command, argsPrefix } = getNpmSpawnInfo();
  const fullArgs = [...argsPrefix, ...args];
  const isWindowsScript = command.endsWith(".cmd") || command.endsWith(".bat");
  if (isWindowsScript) {
    return new Promise((resolve) => {
      const child = spawn("cmd.exe", ["/d", "/s", "/c", command, ...fullArgs], {
        stdio: "inherit",
        shell: false,
        ...opts,
      });
      child.on("close", (code) => resolve(code ?? 1));
      child.on("error", () => resolve(1));
    });
  }
  return new Promise((resolve) => {
    const child = spawn(command, fullArgs, {
      stdio: "inherit",
      shell: false,
      ...opts,
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--smoke") || argv.includes("--dry")) {
    console.log("bench: smoke – verifying portable npm spawn...");
    const code = await runNpm(["--version"], { env: process.env });
    if (code !== 0) {
      console.error(`bench: smoke failed with code ${code}`);
      process.exit(code);
    }
    console.log("bench: smoke passed – npm launch works on this host.");
    return;
  }
  console.log("bench: starting engineering benchmark (bench:engineering)...");
  const engCode = await runNpm(["run", "bench:engineering"], {
    env: process.env,
  });
  if (engCode !== 0) {
    console.error(`bench: engineering benchmark failed with code ${engCode}`);
    process.exit(engCode);
  }
  console.log(
    "bench: engineering passed – starting browser benchmark (bench:browser, Chromium production preview)...",
  );
  const browserCode = await runNpm(["run", "bench:browser"], {
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

if (process.argv[1]?.endsWith("bench.mjs")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
