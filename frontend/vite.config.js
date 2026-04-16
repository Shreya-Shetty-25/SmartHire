import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:8000'
const ASSESSMENT_PROXY_TARGET = process.env.VITE_ASSESSMENT_PROXY_TARGET || API_PROXY_TARGET

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: API_PROXY_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          // SSE connections are long-lived; disable timeouts to prevent ECONNRESET
          proxy.options.timeout = 0
          proxy.options.proxyTimeout = 0
        },
      },
      '/assessment-api': {
        target: ASSESSMENT_PROXY_TARGET,
        changeOrigin: true,
        configure: (proxy) => {
          // SSE connections are long-lived; disable timeouts to prevent ECONNRESET
          proxy.options.timeout = 0
          proxy.options.proxyTimeout = 0
        },
      },
    },
  },
})
