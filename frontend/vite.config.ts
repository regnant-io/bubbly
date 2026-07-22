import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // The WEB dev build gets a RANDOM high port (was a fixed 3000) so it never
    // collides with other projects that also want :3000 — the exact case that
    // made Bubbly's web version interfere with whatever else was running. The
    // desktop/Electron build is unaffected: it serves the frontend from its own
    // fixed backend port and doesn't use this dev server at all. Set FRONTEND_PORT
    // to pin it when you want a stable address; Vite prints the chosen URL on start.
    port: Number(process.env.FRONTEND_PORT) || (34000 + Math.floor(Math.random() * 1000)),
    strictPort: false,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
