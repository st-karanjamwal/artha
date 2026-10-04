/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// Same policy as production nginx (frontend/nginx.conf), so `vite preview` and E2E run under it.
const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; " +
  "base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    port: 5173,
    proxy: { '/api': process.env.ARTHA_API ?? 'http://127.0.0.1:8000' },
  },
  preview: {
    proxy: { '/api': process.env.ARTHA_API ?? 'http://127.0.0.1:8000' },
    headers: { 'Content-Security-Policy': CSP, 'X-Frame-Options': 'DENY' },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
  },
});
