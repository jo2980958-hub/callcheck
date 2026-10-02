import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: { port: 15742, proxy: { '/api': 'http://localhost:18742' } },
  build: { sourcemap: false, chunkSizeWarningLimit: 600 },
});
