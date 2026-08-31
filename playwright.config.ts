import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  // Single worker keeps heavy generation suites serial and the browser benchmark uncontended.
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command:
      "npm run build && npm run preview -w @openvibecoaster/web -- --host 127.0.0.1",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // Exercise full Chromium's production headless path. The legacy
        // chrome-headless-shell process is not stable for the hour-long,
        // SwiftShader-backed 53-seed benchmark on Windows.
        channel: "chromium",
        launchOptions: {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-webgl",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
            "--disable-dev-shm-usage",
          ],
        },
      },
    },
  ],
});
