import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API is proxied so the browser sees one origin in development. That
    // keeps cookies, CORS and relative URLs behaving the same way they will
    // behind the production reverse proxy.
    proxy: {
      '/api': {
        // 127.0.0.1, not localhost: on Node 18+ `localhost` resolves to ::1
        // first, while the API listens on 0.0.0.0 (IPv4 only), so every
        // proxied request hangs until it times out.
        target: process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3100',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
