import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

function pdfAssets() {
  const base = resolve('node_modules/pdfjs-dist')
  const assets = new Map<string, Buffer>()
  for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    for (const name of readdirSync(resolve(base, directory))) assets.set(`pdfjs/${directory}/${name}`, readFileSync(resolve(base, directory, name)))
  }
  assets.set('pdfjs/LICENSE', readFileSync(resolve(base, 'LICENSE')))
  return {
    name: 'bundled-pdf-assets',
    generateBundle(this: { emitFile: (asset: { type: 'asset'; fileName: string; source: Buffer }) => unknown }) {
      for (const [fileName, source] of assets) this.emitFile({ type: 'asset', fileName, source })
    }
  }
}

export default defineConfig({
  root: resolve('src/renderer'),
  base: './',
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: {
    outDir: resolve('dist/tauri'),
    emptyOutDir: true,
    rollupOptions: { input: { index: resolve('src/renderer/index.html'), diagram: resolve('src/renderer/diagram-renderer.html') } }
  },
  resolve: { alias: { '@shared': resolve('src/shared') } },
  plugins: [react(), tailwindcss(), pdfAssets()]
})
