import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Proxy the API in dev so the browser only ever talks to one origin.
    proxy: {
      '/auth': 'http://127.0.0.1:8000',
      '/tasks': 'http://127.0.0.1:8000',
      '/kpi': 'http://127.0.0.1:8000',
      '/health': 'http://127.0.0.1:8000',
    },
  },
})
