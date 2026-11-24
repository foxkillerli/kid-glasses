import { defineConfig } from 'vitest/config'

export default defineConfig({
  server: { host: 'localhost', port: 5173, strictPort: true },
  build: { target: 'esnext' },
  test: { include: ['tests/**/*.test.ts'] },
})
