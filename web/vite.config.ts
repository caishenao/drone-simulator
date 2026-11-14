import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Cesium 走 public/cesium 的 UMD 构建（由 scripts/prepare-assets.mjs 从
// node_modules/cesium/Build/Cesium 同步），因此不参与 Vite 依赖预打包，
// 冷启动与构建都更稳定；类型仍来自 npm 包 cesium。
export default defineConfig({
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  preview: { port: 5199 },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
})
