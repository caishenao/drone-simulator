/* sky_ground.js —— 天空 / 地面视觉分层（无依赖，仅依赖 three）
 *
 * 设计要点：
 *   1. 天空用竖向渐变 CanvasTexture（天顶深蓝 → 地平线浅蓝白）
 *   2. 地面是**不透明实体材质**的暖灰圆盘，与冷蓝天空形成明确色相/明度区分
 *   3. 地面圆盘半径远大于网格半边长，避免出现地平接缝
 *   4. fog 颜色取地平线色，把圆盘远缘融进天空，得到干净的地平线
 *   5. 关键防穿模：地面与网格都放在物理地面 y=0 **之下**
 *      （地面 -0.003·scale，网格 -0.0015·scale），
 *      而物理接触保证脚底 ≥ +0.003·scale，任何姿态下地面元素都不会穿过模型
 */
import * as THREE from 'three';

export function createSkyGround(scene, opts = {}) {
  const scale = opts.scale ?? 1;              // 显示缩放（主预览页 10×）
  const gridSize = opts.gridSize ?? 2 * scale;
  const divisions = opts.divisions ?? 20;
  const radius = opts.radius ?? gridSize * 3; // > 网格半边长，避免地平接缝
  const horizon = opts.horizon ?? '#dce8ef';

  // ---- 天空渐变
  const canvas = document.createElement('canvas');
  canvas.width = 2; canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.00, '#2f6099');         // 天顶深蓝
  grad.addColorStop(0.55, '#8fb4d6');         // 中层
  grad.addColorStop(1.00, horizon);           // 地平线浅蓝白
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 2, 256);
  const sky = new THREE.CanvasTexture(canvas);
  sky.colorSpace = THREE.SRGBColorSpace ?? sky.colorSpace;
  scene.background = sky;

  const fogColor = new THREE.Color(horizon);
  // near 必须小于 far；同时保证相机到模型的距离远小于 near，模型不会被雾 washed out
  scene.fog = new THREE.Fog(fogColor, radius * 0.6, radius * 1.25);

  // ---- 不透明实体地面（暖灰，与冷蓝天空区分）
  const groundMat = new THREE.MeshStandardMaterial({
    color: opts.groundColor ?? 0xd2d7da,
    roughness: 0.94, metalness: 0.0,
  });
  const ground = new THREE.Mesh(new THREE.CircleGeometry(radius, 96), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.003 * scale;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- 技术网格线：在地面之上、物理地面之下
  const grid = new THREE.GridHelper(gridSize, divisions, 0x708a9f, 0x9fb0bf);
  grid.position.y = -0.0015 * scale;
  grid.material.transparent = true;
  grid.material.opacity = 0.5;
  grid.material.depthWrite = false;
  scene.add(grid);

  return {
    sky, ground, grid, fog: scene.fog,
    setGridVisible(on) { grid.visible = on; },
    setGroundColor(hex) { groundMat.color.set(hex); },
    dispose() {
      sky.dispose(); ground.geometry.dispose(); groundMat.dispose();
      grid.geometry.dispose(); grid.material.dispose();
      scene.remove(ground); scene.remove(grid);
    },
  };
}

export default createSkyGround;
