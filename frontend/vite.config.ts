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
    /*
     * SPLIT THE BIG, RARELY-CHANGING LIBRARIES OUT OF THE APP BUNDLE.
     *
     * Everything was in one 1.8MB chunk, which has two costs. The obvious one
     * is first paint: the desktop shell shows its splash until that whole file
     * has been parsed. The less obvious and larger one is that ANY change to
     * any app file invalidates the entire bundle — so an editor, a terminal
     * emulator and a syntax highlighter that have not changed in months are
     * re-downloaded every time a button moves.
     *
     * These four are picked because they are large, self-contained, and change
     * on their own schedule rather than with the app.
     */
    chunkSizeWarningLimit: 900,
    rollupOptions: {
      output: {
        manualChunks: {
          editor: ['@monaco-editor/react'],
          terminal: ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-web-links'],
          markdown: ['react-markdown', 'remark-gfm', 'rehype-highlight', 'highlight.js'],
          motion: ['framer-motion'],
        },
      },
    },
  },
});
