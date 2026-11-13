import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { readFileSync, readdirSync } from 'node:fs'

// Keep CMaps, standard fonts and image decoders available offline in dev and
// packaged builds. Preserve names expected by PDF.js rather than hashing them.
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
    },
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use((request, response, next) => {
        const source = assets.get((request.url || '').split('?')[0].replace(/^\//, ''))
        if (!source) { next(); return }
        response.setHeader('Content-Type', request.url?.endsWith('.wasm') ? 'application/wasm' : request.url?.endsWith('.js') ? 'text/javascript' : 'application/octet-stream')
        response.end(source)
      })
    }
  }
}

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
    plugins: [react(), tailwindcss(), pdfAssets()]
  }
})
