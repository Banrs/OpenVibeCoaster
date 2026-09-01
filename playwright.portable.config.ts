import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "offline.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  // Portable generation has a 90s engineering bound (offline.spec.ts: toHaveAttribute ready).
  // Keep test timeout above that assertion so the 90s bound governs, not the 30s default.
  timeout: 120_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "edge",
      use: {
        ...devices["Desktop Edge"],
        channel: "msedge",
      },
    },
    {
      name: "webkit",
      use: {
        ...devices["Desktop Safari"],
        browserName: "webkit",
      },
    },
  ],
});
