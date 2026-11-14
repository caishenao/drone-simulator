/// <reference types="vite/client" />

import type * as CesiumNamespace from 'cesium'

declare global {
  interface Window {
    /** 由 index.html 中 /cesium/Cesium.js 注入 */
    Cesium: typeof CesiumNamespace
  }
}
