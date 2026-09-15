import { defineConfig, devices } from '@playwright/test';

// Use a dedicated port so these tests never collide with, or reuse, a stale
// dev server running our code from another worktree (which happened often
// because multiple excalidraw-cf-* worktrees bind 5173 by default).
const PORT = 5199;

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
