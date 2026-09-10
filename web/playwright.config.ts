import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './test/browser',
  timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:18426', trace: 'retain-on-failure' },
  webServer: {
    command: 'node --import tsx test/fixture-server.ts',
    url: 'http://127.0.0.1:18426/health/ready',
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      ATPROTO_ACL_TEST_PYTHON: process.env.ATPROTO_ACL_TEST_PYTHON ?? 'python3',
    },
  },
})
