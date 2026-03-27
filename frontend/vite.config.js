import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
      },
      '/assessment-api': {
        target: 'http://127.0.0.1:8100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/assessment-api/, ''),
      },
    },
  },
})
