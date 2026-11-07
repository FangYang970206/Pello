import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {},
  preload: {
    build: {
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    build: { rollupOptions: { input: { index: resolve('src/renderer/index.html'), diagram: resolve('src/renderer/diagram-renderer.html') } } },
    resolve: {
      alias: { '@shared': resolve('src/shared') }
    },
    plugins: [react(), tailwindcss()]
  }
})
