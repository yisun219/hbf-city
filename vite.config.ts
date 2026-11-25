import { defineConfig } from 'vite'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string }

export default defineConfig({
  base: './',
  define: {
    __HBFCITY_VERSION__: JSON.stringify(pkg.version),
  },
  server: { host: '127.0.0.1', port: 5181, strictPort: true, open: false },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,
    modulePreload: { polyfill: false },
  },
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    environment: 'node',
  },
})
