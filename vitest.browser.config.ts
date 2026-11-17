import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// Tests that need a real browser: script execution, CSP, sandboxed iframes.
// `pnpm test:browser` (Chromium through Playwright); `pnpm test` skips them.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
})
