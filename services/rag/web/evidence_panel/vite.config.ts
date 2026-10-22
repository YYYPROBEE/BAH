import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 生产由 FastAPI 挂在 /panel/；开发时用 Vite 代理直连 sidecar。
export default defineConfig({
  plugins: [react()],
  base: '/panel/',
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:7801',
      '/healthz': 'http://127.0.0.1:7801',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
