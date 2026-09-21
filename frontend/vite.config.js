import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy the API in dev so the browser only ever talks to one origin.
    //
    // These prefixes are claimed by the backend, so no client-side route may
    // reuse one: Vite matches by prefix and would hand a hard page load (or a
    // refresh, or a pasted link) to the API instead of the app. The client
    // routes are deliberately named out of the way — /board, /metrics, /people,
    // /login. Adding an API prefix here means checking it against those.
    proxy: {
      '/auth': 'http://127.0.0.1:8000',
      '/tasks': 'http://127.0.0.1:8000',
      '/users': 'http://127.0.0.1:8000',
      '/kpi': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
    },
  },
})
