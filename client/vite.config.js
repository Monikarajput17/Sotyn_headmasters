import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Mam (2026-06-02): we ship a tiny build-stamp into the bundle so a
// visible badge in the header lets us tell at a glance which build is
// running on a given phone / browser.  Was guessing for hours whether
// the iPhone PWA had picked up the latest cards or was still on the
// cached old bundle — this kills that guesswork.
export default defineConfig({
  plugins: [react(), {
    name: 'local-backend-only',
    configResolved(config) {
      if (config.command !== 'serve') return
      const endpoints = {
        API_PROXY_TARGET: config.server.proxy['/api'].target,
        VITE_API_BASE: config.env.VITE_API_BASE || '/api',
        VITE_SUPABASE_URL: config.env.VITE_SUPABASE_URL,
      }
      for (const [name, value] of Object.entries(endpoints)) {
        if (!value) continue
        if (name === 'VITE_API_BASE' && value === '/api') continue
        let local = false
        try {
          const url = new URL(value)
          local = ['http:', 'https:'].includes(url.protocol)
            && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
            && !url.username && !url.password
        } catch { /* Invalid URLs must also fail closed. */ }
        if (!local) {
          throw new Error(`${name} must point to localhost for local testing. Remote backends are blocked to protect production data.`)
        }
      }
    },
  }],
  define: {
    __BUILD_STAMP__: JSON.stringify(
      // ISO without milliseconds — readable in the badge as "06-02 12:45"
      new Date().toISOString().replace(/[T:Z]/g, ' ').slice(5, 16).trim()
    ),
  },
  build: {
    rollupOptions: {
      output: {
        // Pin only the always-eager SHELL vendors into stable, long-cached
        // chunks so an app-code deploy re-hashes just the app entry (react /
        // router / socket / axios stay cached across deploys). Route pages,
        // charts (recharts), maps (leaflet) and html5-qrcode are already
        // React.lazy route-split — left to Rollup's default async chunking.
        // @sentry is NOT pinned here: it's a lazy dynamic import (see sentry.js)
        // and must stay its own async chunk, not be pulled into the initial graph.
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          // @sentry stays a LAZY async chunk (dynamic import in sentry.js) — must
          // be excluded before the react rule below, because its path
          // (node_modules/@sentry/react/…) would otherwise match it.
          if (id.includes('@sentry')) return
          // Keep react + react-dom + router + scheduler TOGETHER (splitting react
          // from react-dom risks init-order bugs). Anchor on node_modules/<pkg>/
          // so scoped packages like @sentry/react don't get swept in.
          if (/node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'react-vendor'
          if (id.includes('socket.io') || id.includes('engine.io')) return 'socket'
          if (id.includes('axios')) return 'net'
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    strictPort: true,
    // Dev-only (server.* is ignored by `vite build`). Pre-transform the
    // logged-in first-route graph at server boot so the FIRST load after each
    // `npm run dev` isn't waiting on cold on-demand transforms of the big
    // Layout + Dashboard trees. Vite transitively warms each file's static
    // import tree, so listing the roots covers their children.
    warmup: {
      clientFiles: [
        './src/main.jsx',
        './src/App.jsx',
        './src/components/Layout.jsx',
        './src/pages/Dashboard.jsx',
      ],
    },
    port: 3055,
    proxy: {
      // Local Supabase Edge Function. Overrides must also use a loopback host.
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:54321/functions/v1/api',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    }
  }
})
