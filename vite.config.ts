import { defineConfig } from 'vite';
import { offlineShell } from './build/offline-shell';
import { pdfResources } from './build/pdf-resources';

export default defineConfig({
  plugins: [pdfResources(), offlineShell()],
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
  build: { target: 'es2022' },
});
