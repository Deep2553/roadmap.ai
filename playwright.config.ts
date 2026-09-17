import { defineConfig } from "@playwright/test";

// Both are overridable so the suite can run against a throwaway DB on a free
// port (e.g. when something else already owns 3000, or in CI).
const port = Number(process.env.E2E_PORT ?? 3000);
const sqlitePath = process.env.SQLITE_PATH ?? "sqlite.e2e.db";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  webServer: {
    command: `npm run dev -- --port ${port}`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    env: { SQLITE_PATH: sqlitePath },
  },
  use: {
    baseURL: `http://localhost:${port}`,
  },
});
