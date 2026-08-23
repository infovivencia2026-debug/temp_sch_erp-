import { defineConfig } from 'vitest/config'
import path from 'node:path'

/* Tests only. Deliberately its own file rather than a `test` block in
   `vite.config.ts`: a standalone config takes precedence for `vitest` and
   leaves the production build config untouched, so nothing here can reach the
   shipped bundle. No React plugin — the tests render with `react-dom/server`
   and esbuild's automatic JSX transform is all that is needed for that. */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    /* `widgets.test.ts` predates any runner: it is a hand-rolled file of plain
       functions driven by its own `runAll()`, with no `describe`/`it` in it, so
       vitest collects it and reports an empty suite. Left exactly as it is —
       porting someone else's tests was not this pass's job — and excluded here
       so `npm test` reflects the suites that are actually written for vitest. */
    exclude: ['src/lib/widgets.test.ts', '**/node_modules/**'],
  },
})
