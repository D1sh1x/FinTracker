import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5174",
    headless: true,
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "go run ./cmd/fintrack",
      cwd: "../backend",
      url: "http://127.0.0.1:8001/health/ready",
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL:
          "postgres://fintrack:fintrack@127.0.0.1:5432/fintrack_e2e_test",
        LISTEN_ADDR: "127.0.0.1:8001",
      },
    },
    {
      command: "npm run dev -- --port 5174",
      url: "http://127.0.0.1:5174",
      reuseExistingServer: false,
      timeout: 30_000,
      env: { VITE_API_TARGET: "http://127.0.0.1:8001" },
    },
  ],
});
