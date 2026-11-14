/* follow_camera.js —— 无人机第三人称跟随相机（无依赖，仅依赖 three）
 *
 * 三种模式：
 *   'world' 固定世界方位跟随：相机在机体 + 固定偏移，机身翻滚时画面不晕
 *   'body'  追尾跟随：只提取机体 yaw，不跟随 pitch/roll（避免眩晕），机头始终朝画面深处
 *   'off'   自由视角：交回 OrbitControls，用户随便看
 *
 * 跟随时接管 OrbitControls（controls.enabled=false），自己算位置与 lookAt；
 * 切回自由视角时把 controls.target 同步为当前视点，避免跳变。
 * 平滑用 1-exp(-λ·dt)，与帧率无关。
 */
import * as THREE from 'three';

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const UP = new THREE.Vector3(0, 1, 0);

export class FollowCamera {
  constructor(camera, controls, domElement, opts = {}) {
    this.camera = camera;
    this.controls = controls;
    this.dom = domElement;
    this.mode = opts.mode ?? 'world';           // world | body | off
    this.distance = opts.distance ?? 1.0;
    this.baseOffset = new THREE.Vector3(
      ...(opts.offset ?? [0.45, 0.28, 0.72]));
    this.minDistance = opts.minDistance ?? 0.35;
    this.maxDistance = opts.maxDistance ?? 8.0;
    this.posLambda = opts.posLambda ?? 10.0;
    this.targetLambda = opts.targetLambda ?? 18.0;
    // 一阶平滑对匀速目标有 v/λ 的稳态滞后，用速度前馈抵消（lead ≈ 1/λ）
    this.lead = opts.lead ?? 0.055;
    this.lookAhead = opts.lookAhead ?? 0.0;     // 沿机头方向前视距离
    this._prevPos = null;
    this._vel = new THREE.Vector3();
    this._instVel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this._smoothTarget = new THREE.Vector3();
    this._goal = new THREE.Vector3();
    this._off = new THREE.Vector3();
    this._target = new THREE.Vector3();
    this._tmpQ = new THREE.Quaternion();
    this._tmpE = new THREE.Euler(0, 0, 0, 'YXZ');
    this._dragging = false;
    this._last = { x: 0, y: 0 };
    this._bind();
    this._applyMode();
  }

  _bind() {
    this._onWheel = e => {
      if (this.mode === 'off') return;
      e.preventDefault();
      this.distance = clamp(
        this.distance * (e.deltaY > 0 ? 1.10 : 0.90),
        this.minDistance, this.maxDistance);
    };
    this._onDown = e => {
      if (this.mode === 'off') return;
      this._dragging = true;
      this._last = { x: e.clientX, y: e.clientY };
    };
    this._onMove = e => {
      if (!this._dragging || this.mode === 'off') return;
      const dx = e.clientX - this._last.x, dy = e.clientY - this._last.y;
      this._last = { x: e.clientX, y: e.clientY };
      this.yaw -= dx * 0.005;
      this.pitch = clamp(this.pitch + dy * 0.004, -0.55, 1.05);
    };
    this._onUp = () => { this._dragging = false; };
    this.dom.addEventListener('wheel', this._onWheel, { passive: false });
    this.dom.addEventListener('pointerdown', this._onDown);
    window.addEventListener('pointermove', this._onMove);
    window.addEventListener('pointerup', this._onUp);
  }

  _applyMode() {
    this.controls.enabled = (this.mode === 'off');
    if (this.mode === 'off') this.controls.target.copy(this._smoothTarget);
  }

  setMode(mode) {
    if (!['world', 'body', 'off'].includes(mode)) return;
    const wasOff = this.mode === 'off';
    this.mode = mode;
    this._applyMode();
    if (wasOff && mode !== 'off') this.snapPending = true;
  }

  cycleMode() {
    const order = ['world', 'body', 'off'];
    this.setMode(order[(order.indexOf(this.mode) + 1) % order.length]);
    return this.mode;
  }

  setDistance(v) { this.distance = clamp(v, this.minDistance, this.maxDistance); }

  /** 立即把相机放到目标位置（复位时用），避免从旧位置插值飞过去 */
  snap(position, quaternion) {
    this._vel.set(0, 0, 0);
    this._prevPos = position.clone();
    this._compute(position, quaternion, 0);
    this.camera.position.copy(this._goal);
    this._smoothTarget.copy(this._target);
    this.controls.target.copy(this._target);
    this.camera.lookAt(this._target);
    this.snapPending = false;
  }

  _compute(position, quaternion, dt = 0) {
    if (dt > 0 && this._prevPos) {
      this._instVel.copy(position).sub(this._prevPos).divideScalar(dt);
      this._vel.lerp(this._instVel, 0.35);      // 平滑速度估计，抗 dt 抖动
    }
    this._prevPos = position.clone();
    this._off.copy(this.baseOffset).multiplyScalar(this.distance);
    // 用户拖拽的方位角（绕世界 Y）与俯仰角
    this._off.applyAxisAngle(UP, this.yaw);
    const right = new THREE.Vector3().crossVectors(UP, this._off);
    if (right.lengthSq() > 1e-8) {
      right.normalize();
      this._off.applyAxisAngle(right, this.pitch);
    }
    if (this.mode === 'body' && quaternion) {
      // 只取 yaw：追尾相机不跟随机体俯仰/横滚，否则画面会剧烈翻滚
      this._tmpE.setFromQuaternion(quaternion, 'YXZ');
      this._tmpQ.setFromEuler(new THREE.Euler(0, this._tmpE.y, 0, 'YXZ'));
      this._off.applyQuaternion(this._tmpQ);
    }
    this._goal.copy(position).add(this._off)
      .addScaledVector(this._vel, this.lead * 0.5);
    this._target.copy(position).addScaledVector(this._vel, this.lead);
    if (this.lookAhead > 0 && quaternion) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(quaternion);
      this._target.addScaledVector(fwd, this.lookAhead);
    }
  }

  /** 每帧调用；替代外部的 controls.update() */
  update(dt, position, quaternion) {
    if (this.mode === 'off') {
      this.controls.update();
      return;
    }
    this._compute(position, quaternion, dt);
    if (this.snapPending) {
      this.camera.position.copy(this._goal);
      this._smoothTarget.copy(this._target);
      this.snapPending = false;
    } else {
      const a = 1 - Math.exp(-this.posLambda * Math.min(dt, 0.1));
      const b = 1 - Math.exp(-this.targetLambda * Math.min(dt, 0.1));
      this.camera.position.lerp(this._goal, a);
      this._smoothTarget.lerp(this._target, b);
    }
    this.controls.target.copy(this._smoothTarget);
    this.camera.lookAt(this._smoothTarget);
  }

  /** 自检 / 调试用 */
  state(position) {
    return {
      mode: this.mode,
      distance: this.distance,
      camera: this.camera.position.toArray(),
      target: this._smoothTarget.toArray(),
      drone: position ? position.toArray() : null,
      lag: position ? this._smoothTarget.distanceTo(position) : null,
    };
  }

  dispose() {
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('pointerdown', this._onDown);
    window.removeEventListener('pointermove', this._onMove);
    window.removeEventListener('pointerup', this._onUp);
  }
}

export default FollowCamera;
