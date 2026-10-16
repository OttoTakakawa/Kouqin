import { defineConfig } from "@playwright/test";
import path from "node:path";
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 40000,
  outputDir: "work/test-results",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4319",
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
      args: ["--autoplay-policy=no-user-gesture-required"],
    },
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node server.mjs",
    url: "http://127.0.0.1:4319/api/health",
    reuseExistingServer: false,
    env: {
      PORT: "4319",
      HARMONICA_DATA: path.resolve("work/e2e-data-" + Date.now()),
      HARMONICA_LIBRARY: path.resolve("tests/fixtures/library"),
      HARMONICA_VAULT: path.resolve("tests/fixtures"),
    },
  },
});
