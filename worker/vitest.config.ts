/* Integration tests: the real Worker (src/index.ts) inside workerd via
   Miniflare, with local D1, R2, Queues and the LiveHub Durable Object.
   Bindings come from test/integration/wrangler.test.jsonc, never from
   wrangler.jsonc, so no test can touch a Cloudflare resource.
   Run: npm test (see docs/cloudflare-stack.md, "Testing and deploying"). */
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './test/integration/wrangler.test.jsonc' } })],
  test: {
    include: ['test/integration/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
