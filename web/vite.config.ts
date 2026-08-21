import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  server: {
    port: 5173,
    // Mirrors the nginx locations, so `npm run dev` hits the same URLs the
    // production bundle does and no code needs a base-URL switch.
    proxy: {
      '/api': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
      '/login': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
      '/logout': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
      '/healthz': { target: 'https://temperp.187-127-178-100.sslip.io', changeOrigin: true, secure: false },
    },
  },
  build: {
    // Chunked along the same seams as the deployed bundle: the vendor libs
    // change rarely and stay cached across deploys, while feature code does
    // not drag them back over the wire.
    rollupOptions: {
      output: {
        // Matched on resolved module path rather than the bare package name.
        // The name-keyed form emits an empty `react` chunk here, because
        // react/jsx-runtime and react-dom get pulled in transitively by
        // react-router-dom and land in that chunk instead.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'react'
          if (id.includes('react-router')) return 'router'
          if (id.includes('@tanstack')) return 'query'
          if (id.includes('recharts') || id.includes('d3-')) return 'charts'
          if (id.includes('lucide-react')) return 'icons'
          return 'vendor'
        },
      },
    },
  },
})
