import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}', 'test/**/*.test.ts'],
    // Real-browser tests run with `pnpm test:browser` (vitest.browser.config.ts).
    exclude: ['**/node_modules/**', '**/*.browser.test.ts'],
    environment: 'node',
    // CopilotKit's v2 entry imports CSS; let Vite process it.
    server: { deps: { inline: [/@copilotkit/] } },
  },
})
