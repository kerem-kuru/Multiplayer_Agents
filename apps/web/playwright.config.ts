import { defineConfig } from "@playwright/test";

/**
 * Testler zaten ayakta olan sunucuya karsi kosar (webServer BASLATMAZ):
 * gercek agent kosumu anahtar ister ve onu CI'da kendiliginden ayaga
 * kaldirmak dogru degil. Once `npm run api` ve `npm run dev:web`.
 */
export default defineConfig({
  testDir: "./tests",
  timeout: 300_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
  },
});
