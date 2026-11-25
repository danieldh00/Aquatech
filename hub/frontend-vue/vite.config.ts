// Vite-instellingen: één pagina per gemigreerde module (src/modules/<id>/index.html), uitvoer in dist/<id>/index.html
// met gedeelde stukken in dist/assets/. Alle adressen zijn relatief (base './'), zodat de app ook onder /app/ achter
// een proxy werkt. De ontwikkelserver stuurt API, schil en nog niet gemigreerde modules door naar de gewone backend.
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import { shellHtmlPlugin } from './tools/shell-html'

const modulesDir = fileURLToPath(new URL('./src/modules', import.meta.url))

/** Ids van alle modules met een eigen index.html (mapnaam = URL onder /app/). */
const moduleIds = existsSync(modulesDir)
  ? readdirSync(modulesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(resolve(modulesDir, entry.name, 'index.html')))
      .map((entry) => entry.name)
  : []

/** Alles wat niet van Vite zelf (@vite, src, node_modules) of van een gemigreerde module is, gaat naar de backend. */
const proxyPattern = `^/(?!@|src/|node_modules/|__)(?!(?:${moduleIds.join('|') || '__geen__'})(?:/|$)).*`

/** Adres van de gewone backend voor de ontwikkelserver (`BACKEND_URL`, standaard poort 3300). */
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3300'

export default defineConfig({
  root: modulesDir,
  base: './',
  plugins: [vue(), shellHtmlPlugin()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: { input: Object.fromEntries(moduleIds.map((id) => [id, resolve(modulesDir, id, 'index.html')])) },
  },
  server: {
    port: 5173,
    fs: { allow: [fileURLToPath(new URL('.', import.meta.url))] },
    proxy: {
      [proxyPattern]: {
        target: backendUrl,
        changeOrigin: true,
        rewrite: (path: string) => '/app' + path,
      },
    },
  },
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    environment: 'jsdom',
    include: ['test/**/*.test.ts'],
  },
})
