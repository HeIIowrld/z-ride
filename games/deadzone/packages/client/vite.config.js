import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  base: mode === 'demo' ? '/deadzone-demo/' : '/',
  publicDir: mode === 'demo' ? false : 'public',
  plugins: mode === 'demo' ? [{
    name: 'standalone-demo-html',
    transformIndexHtml: {
      order: 'pre',
      handler: html => html.replace(/^<link rel="(?:manifest|apple-touch-icon|icon)"[^\n]*\n/gm, '')
    }
  }] : [],
  resolve: {
    alias: {
      // The shared simulation is imported by path so the same files are used
      // verbatim by the Cloudflare Worker, which has no bundler aliases.
      '@overrun/shared': resolve(here, '../shared/src')
    }
  },
  build: {
    target: 'es2022',
    minify: 'terser',
    terserOptions: {
      compress: { passes: 2, drop_console: true, drop_debugger: true },
      format: { comments: false }
    },
    rollupOptions: {
      input: mode === 'demo'
        ? resolve(here, 'index.html')
        : { game: resolve(here, 'index.html'), dashboard: resolve(here, 'dashboard.html'), infected: resolve(here, 'infected.html') },
      output: {
        // three.js is the only heavy dependency; splitting it means a game
        // update does not invalidate a 600kB cache entry the player already has.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          if (id.includes('/shared/src/')) return 'sim';
        }
      }
    },
    chunkSizeWarningLimit: 1200,
    assetsInlineLimit: 4096
  },
  server: { host: true, port: 5173 }
}));
