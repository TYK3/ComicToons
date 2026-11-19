import {defineConfig} from 'vite';
import {fileURLToPath} from 'node:url';

// Static Sample demo for hosting (Vercel). Uses the MockAdapter entry, so no API, keys or Twitch are needed.
// Build: npm run build:demo  ->  apps/web/dist-demo (open /demo.html, "/" is rewritten there by vercel.json).
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: 'dist-demo',
    emptyOutDir: true,
    rollupOptions: {input: {demo: fileURLToPath(new URL('./demo.html', import.meta.url))}},
  },
});