import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Mam (2026-06-02): we ship a tiny build-stamp into the bundle so a
// visible badge in the header lets us tell at a glance which build is
// running on a given phone / browser.  Was guessing for hours whether
// the iPhone PWA had picked up the latest cards or was still on the
// cached old bundle — this kills that guesswork.
export default defineConfig({
  plugins: [react()],
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
      // Use 127.0.0.1, NOT "localhost": on Node 17+ "localhost" resolves to IPv6
      // ::1 first, but the API server binds IPv4 only -> "connect ECONNREFUSED
      // ::1:5000", which vite surfaces as a 500 on every proxied login in dev.
      // Sotyn Salon fork runs the API on 5055 to avoid clashing with the
      // business-erp project on 5000.
      '/api': 'http://127.0.0.1:5055',
      '/socket.io': { target: 'http://127.0.0.1:5055', ws: true }
    }
  }
})
