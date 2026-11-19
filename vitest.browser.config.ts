import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'

// Tests that need a real browser: script execution, CSP, sandboxed iframes, audio capture.
// `pnpm test:browser` (Chromium through Playwright); `pnpm test` skips them.
export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.browser.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({
        launchOptions: {
          // Microphone tests: a fake capture device (a periodic beep), no permission prompt,
          // and AudioContexts that run without a user gesture.
          args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      }),
      instances: [{ browser: 'chromium' }],
      screenshotFailures: false,
    },
  },
})
