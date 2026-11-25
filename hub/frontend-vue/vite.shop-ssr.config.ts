// Bouwt de server-side tekenlaag van de webshop tot één bestand (`shop-ssr.mjs`, Vue zit erin) dat de Node-backend inleest.
// Draait alleen in de Docker-bouwstap; het runtime-image bevat dit ene bestand, geen node_modules van dit project.
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  build: {
    ssr: fileURLToPath(new URL('./src/shop/ssr-entry.ts', import.meta.url)),
    outDir: fileURLToPath(new URL('./dist-shop-ssr', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    minify: true,
    rollupOptions: { output: { format: 'es', entryFileNames: 'shop-ssr.mjs' } },
  },
  ssr: { noExternal: true },
})
