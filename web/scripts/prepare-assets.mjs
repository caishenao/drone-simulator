// 把 Cesium 运行时资源与无人机 GLB 同步到 public/，供 UMD 方式加载。
// 幂等：Cesium 版本未变则跳过（避免每次 dev/build 重复拷贝 23 MB）。
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const log = (...a) => console.log('[assets]', ...a)

/** 逐文件递归复制：Node 22 的 fs.cpSync 在部分 Windows 环境下会整进程退出 */
function copyDir(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const s = join(src, entry.name)
    const d = join(dst, entry.name)
    if (entry.isDirectory()) copyDir(s, d)
    else if (entry.isFile()) copyFileSync(s, d)
  }
}

const cesiumPkg = join(root, 'node_modules', 'cesium', 'package.json')
if (!existsSync(cesiumPkg)) {
  console.error('[assets] 未找到 node_modules/cesium，请先执行 npm install')
  process.exit(1)
}
const version = JSON.parse(readFileSync(cesiumPkg, 'utf8')).version
const srcBuild = join(root, 'node_modules', 'cesium', 'Build', 'Cesium')
const dstBuild = join(root, 'public', 'cesium')
const marker = join(dstBuild, '.version')

const upToDate =
  existsSync(marker) && readFileSync(marker, 'utf8').trim() === version && existsSync(join(dstBuild, 'Cesium.js'))

if (upToDate) {
  log(`Cesium ${version} 已就绪`)
} else {
  rmSync(dstBuild, { recursive: true, force: true })
  mkdirSync(dstBuild, { recursive: true })
  for (const item of ['Cesium.js', 'Assets', 'Widgets', 'Workers', 'ThirdParty']) {
    const src = join(srcBuild, item)
    const out = join(dstBuild, item)
    if (statSync(src).isDirectory()) copyDir(src, out)
    else copyFileSync(src, out)
  }
  writeFileSync(marker, `${version}\n`, 'utf8')
  log(`Cesium ${version} -> public/cesium`)
}

// 无人机模型：源文件在上一级目录，改型后自动覆盖
const glbSrc = resolve(root, '..', 'drone_mini3pro.glb')
const glbDst = join(root, 'public', 'models', 'drone_mini3pro.glb')
mkdirSync(dirname(glbDst), { recursive: true })
if (existsSync(glbSrc)) {
  const newer = !existsSync(glbDst) || statSync(glbSrc).mtimeMs > statSync(glbDst).mtimeMs
  if (newer) {
    copyFileSync(glbSrc, glbDst)
    log(`模型 -> public/models (${(statSync(glbDst).size / 1024).toFixed(0)} KB)`)
  } else {
    log('模型已是最新')
  }
} else {
  console.warn('[assets] 未找到 ../drone_mini3pro.glb')
}

if (!existsSync(join(root, 'public', 'data', 'buildings.geojson'))) {
  console.warn('[assets] 缺少 public/data/buildings.geojson，请运行 npm run buildings')
}
