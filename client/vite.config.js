import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
  },
  server: {
    port: 5173,
    proxy: {
      // Must come first: the collab endpoint is a websocket upgrade, and vite
      // matches proxy entries in declaration order.
      '/api/collab': { target: 'ws://localhost:3000', ws: true },
      '/api': 'http://localhost:3000',
    },
  },
  // The lint worker (src/editor/code/lintWorker.js) lazily imports one parser
  // per language, so it is a code-splitting build — and rollup cannot split an
  // IIFE, which is vite's default worker format. The worker is already spawned
  // with `{ type: 'module' }`, so ES is both required and correct.
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 3000,
  },
});
