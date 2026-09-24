/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Default export is required by Vite.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The API Worker from `make dev-worker`; API_URL=http://127.0.0.1:8000 for the Python API.
    proxy: {
      '/api': process.env.API_URL ?? 'http://127.0.0.1:8787',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}', 'worker/**/*.test.ts'],
  },
})
