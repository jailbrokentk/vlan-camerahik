import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: mode === 'debug' ? false : 'esbuild',
    sourcemap: mode === 'debug'
  },
  server: {
    port: 5173,
    strictPort: true
  }
}))
