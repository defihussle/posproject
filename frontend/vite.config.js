import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Serve backoffice.html for /backoffice* in dev and preview.
//
// Production does this with the rewrite rules in public/_redirects, but the
// dev and preview servers don't read that file — their SPA fallback would hand
// back index.html instead, so the two-entry split would only ever be exercised
// in production. That's exactly the kind of divergence that hides a broken
// Home Screen icon until it's live.
function backofficeEntry() {
  const rewrite = (req, _res, next) => {
    const path = (req.url || '').split('?')[0]
    if (path === '/backoffice' || path.startsWith('/backoffice/')) {
      req.url = '/backoffice.html'
    }
    next()
  }
  // Block bodies on purpose: server.middlewares.use() returns the connect app,
  // and Vite treats a *returned function* from these hooks as a post-hook to
  // invoke later — which crashes the server on startup.
  return {
    name: 'backoffice-entry',
    configureServer(server) {
      server.middlewares.use(rewrite)
    },
    configurePreviewServer(server) {
      server.middlewares.use(rewrite)
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), backofficeEntry()],
  build: {
    rollupOptions: {
      // Two HTML entries sharing one JS bundle. See backoffice.html for why
      // Back Office needs a document of its own.
      input: {
        main: 'index.html',
        backoffice: 'backoffice.html',
      },
    },
  },
})
