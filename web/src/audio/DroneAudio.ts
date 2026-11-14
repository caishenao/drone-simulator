/**
 * 程序化无人机音效：全部用 Web Audio 现场合成，不加载任何音频文件。
 *
 * 为什么不做采样循环：
 * 1) 电机声必须随转速连续变化。采样只有「变调」一条路，推到高转数就成了花栗鼠，
 *    降到低转数又会拖成慢放，而四旋翼从怠速到满油是一倍半的音高跨度。
 * 2) 四旋翼的质感主要来自四个电机转速略有差异形成的拍频（几 Hz 的「嗡嗡」起伏），
 *    合成里给四个振荡器各一点失谐就能拿到，采样反而要去对齐循环点。
 * 3) 不增加静态资源体积，也没有素材版权问题。
 *
 * 浏览器的自动播放策略要求 AudioContext 必须由用户手势唤醒，
 * 所以这里分成两步：构造时什么都不做，arm() 挂一次性手势监听，unlock() 才建图。
 */

/** 桨叶数：两叶桨 → 每转激励两次空气，这是四旋翼「嗡嗡」声的基频来源 */
const BLADES = 2
/** 满油转速（rpm）。悬停 6000，满推力约 8900，留一点余量给瞬时超调 */
const RPM_MAX = 9200
/** 四个电机的失谐比例：制造拍频，别让四条声线完全同相 */
const DETUNE = [-0.011, -0.0035, 0.0042, 0.0125]

export interface AudioFrame {
  /** 四个电机转速（rpm，负值表示反转） */
  rpms: number[]
  /** 空速 m/s */
  speed: number
  /** 垂速 m/s（正为爬升） */
  vertical: number
  /** 当前油门，3D 模式下可为负 */
  throttle: number
  /** 是否触地 */
  contact: boolean
  /** 是否已解体（解体后电机立即静音） */
  crashed: boolean
  /** 是否处于云台第一视角：近场听感，电机更贴耳、风噪略收 */
  fpv: boolean
}

export interface AudioPrefs {
  volume: number
  muted: boolean
  motors: boolean
  wind: boolean
  fx: boolean
}

interface MotorVoice {
  osc: OscillatorNode
  gain: GainNode
  ratio: number
}

const DEFAULT_PREFS: AudioPrefs = {
  volume: 0.7,
  muted: false,
  motors: true,
  wind: true,
  fx: true,
}

export class DroneAudio {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private motorBus: GainNode | null = null
  private motorLp: BiquadFilterNode | null = null
  private whine: OscillatorNode | null = null
  private whineGain: GainNode | null = null
  private propGain: GainNode | null = null
  private windGain: GainNode | null = null
  private windLp: BiquadFilterNode | null = null
  private noiseBuf: AudioBuffer | null = null
  private noiseSrc: AudioBufferSourceNode | null = null
  private analyserNode: AnalyserNode | null = null
  private voices: MotorVoice[] = []
  private prefs: AudioPrefs = { ...DEFAULT_PREFS }
  private armed = false
  /** 一次性手势监听函数引用，dispose 时用来摘除 */
  private gestureHandler: (() => void) | null = null
  private frame: AudioFrame = {
    rpms: [0, 0, 0, 0],
    speed: 0,
    vertical: 0,
    throttle: 0,
    contact: false,
    crashed: false,
    fpv: false,
  }
  /** 最近一次真正下发到音频节点的数值，供自检读取（gain.value 拿不到 setTargetAtTime 的目标值） */
  private stats = { built: false, spin: 0, freq: 0, motor: 0, prop: 0, wind: 0, master: 0, fx: 0 }

  get ready(): boolean {
    return this.stats.built && this.ctx?.state === 'running'
  }

  /** 挂在主输出上的分析节点，供自检读取真实波形 */
  get analyser(): AnalyserNode | null {
    return this.analyserNode
  }

  /** 挂一次性手势监听。必须在页面上有任何点击/按键之前调用，否则会漏掉第一次交互 */
  arm(): void {
    if (this.armed) return
    this.armed = true
    const go = () => {
      void this.unlock().then((ok) => {
        if (ok) this.armCue()
      })
    }
    // 记住监听引用：dispose() 必须摘掉，否则场景重建时同一个手势会触发多次解锁提示音
    this.gestureHandler = go
    window.addEventListener('pointerdown', go, { passive: true })
    window.addEventListener('keydown', go)
    window.addEventListener('touchstart', go, { passive: true })
  }

  /** 建上下文并启动。用户手势之外调用只会拿到 suspended，所以外部不需要手动调 */
  async unlock(): Promise<boolean> {
    if (!this.ctx) {
      const AC =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return false
      try {
        this.ctx = new AC({ latencyHint: 'interactive' })
        this.build()
      } catch {
        this.ctx = null
        return false
      }
    }
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume()
      } catch {
        /* 设备被占用或策略拒绝：静默降级，飞行本身不受影响 */
      }
    }
    return this.ctx.state === 'running'
  }

  configure(next: Partial<AudioPrefs>): void {
    this.prefs = { ...this.prefs, ...next }
    this.applyMaster()
    // 开关变了就立刻重算增益：否则关掉电机声要等下一次遥测节流（最多 125 ms）才生效，
    // 用户会听到一截残留声
    this.reapplyLevels()
  }

  /** 按当前 prefs 与最近一帧转速重新下发各分层增益 */
  private reapplyLevels(): void {
    const ctx = this.ctx
    if (!ctx || !this.stats.built || ctx.state !== 'running') return
    const f = this.frame
    const mean = Math.abs(f.rpms.reduce((s, x) => s + x, 0)) / 4
    const spin = f.crashed ? 0 : Math.min(1.35, mean / RPM_MAX)
    const freq = (mean / 60) * BLADES
    this.applyLevels(ctx.currentTime, spin, freq, f)
  }

  private applyMaster(): void {
    const ctx = this.ctx
    if (!ctx || !this.master) return
    const target = this.prefs.muted ? 0 : Math.min(1, Math.max(0, this.prefs.volume)) * 0.9
    this.stats.master = target
    this.master.gain.setTargetAtTime(target, ctx.currentTime, 0.04)
  }

  /** 二维粉噪：比白噪更接近气流，也不会像纯白噪那样刺耳 */
  private makeNoise(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 2)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const d = buf.getChannelData(0)
    let b0 = 0
    let b1 = 0
    let b2 = 0
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1
      b0 = 0.99765 * b0 + w * 0.099046
      b1 = 0.963 * b1 + w * 0.2965164
      b2 = 0.57 * b2 + w * 1.0526913
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25
    }
    return buf
  }

  private build(): void {
    const ctx = this.ctx
    if (!ctx) return
    const master = ctx.createGain()
    master.gain.value = this.prefs.muted ? 0 : this.prefs.volume * 0.9
    // 分析节点挂在 master 与 destination 之间：不改变听感，但让自检能读到
    // 真实输出波形（确认不是静音、主频落在桨叶通过频率上）
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.2
    master.connect(analyser)
    analyser.connect(ctx.destination)
    this.master = master
    this.analyserNode = analyser
    this.stats.master = master.gain.value

    const buf = this.makeNoise(ctx)
    this.noiseBuf = buf
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.loop = true
    src.start()
    this.noiseSrc = src

    // 桨叶切气的宽带噪声：带通在 1 kHz 附近，随转速升高变亮
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 950
    bp.Q.value = 0.9
    const pg = ctx.createGain()
    pg.gain.value = 0
    src.connect(bp)
    bp.connect(pg)
    pg.connect(master)
    this.propGain = pg

    // 气流风噪：速度越高，低通的截止频率也越高（风「变硬」）
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 420
    lp.Q.value = 0.6
    const wg = ctx.createGain()
    wg.gain.value = 0
    src.connect(lp)
    lp.connect(wg)
    wg.connect(master)
    this.windLp = lp
    this.windGain = wg

    // 电机总线：低通压掉锯齿波过亮的谐波，避免长时间飞行耳朵累
    const bus = ctx.createGain()
    bus.gain.value = 0
    const mlp = ctx.createBiquadFilter()
    mlp.type = 'lowpass'
    mlp.frequency.value = 2400
    mlp.Q.value = 0.4
    bus.connect(mlp)
    mlp.connect(master)
    this.motorBus = bus
    this.motorLp = mlp

    for (const ratio of DETUNE) {
      const osc = ctx.createOscillator()
      osc.type = 'sawtooth'
      osc.frequency.value = 120
      const g = ctx.createGain()
      // 四路各 1/4，叠加后不削顶
      g.gain.value = 0.25
      osc.connect(g)
      g.connect(bus)
      osc.start()
      this.voices.push({ osc, gain: g, ratio })
    }

    // 桨尖啸叫：高八度正弦。声压很小，但少了它就不像四旋翼
    const wh = ctx.createOscillator()
    wh.type = 'sine'
    wh.frequency.value = 240
    const whg = ctx.createGain()
    whg.gain.value = 0
    wh.connect(whg)
    whg.connect(bus)
    wh.start()
    this.whine = wh
    this.whineGain = whg

    this.stats.built = true
  }

  /** 每 ~120 ms 由遥测推送调用一次。都用 setTargetAtTime，8 Hz 的更新率听起来是连续的 */
  update(frame: AudioFrame): void {
    this.frame = frame
    const ctx = this.ctx
    if (!ctx || !this.stats.built || ctx.state !== 'running') {
      this.stats.spin = 0
      return
    }
    const now = ctx.currentTime
    const tc = 0.07
    const mean = Math.abs(frame.rpms.reduce((s, x) => s + x, 0)) / 4
    const spin = frame.crashed ? 0 : Math.min(1.35, mean / RPM_MAX)
    const freq = (mean / 60) * BLADES

    for (const v of this.voices) {
      v.osc.frequency.setTargetAtTime(Math.max(8, freq * (1 + v.ratio)), now, tc)
    }
    this.whine?.frequency.setTargetAtTime(Math.max(16, freq * 2.02), now, tc)
    this.applyLevels(now, spin, freq, frame)
  }

  /**
   * 把当前转速换算成各分层的增益并下发。
   * 单独抽出来，是因为 configure() 改了开关后必须立刻重新下发一次，
   * 否则「关掉电机声」要等到下一次遥测节流（最多 125 ms）才真正静音，
   * 用户会听到一截残留声。
   */
  private applyLevels(now: number, spin: number, freq: number, frame: AudioFrame): void {
    const tc = 0.07
    const fpv = frame.fpv

    this.whineGain?.gain.setTargetAtTime(
      this.prefs.motors ? 0.16 * Math.pow(spin, 2.2) * (fpv ? 1.25 : 1) : 0,
      now,
      tc,
    )

    // 转速 → 声压用 1.45 次方：接近推力（∝rpm²）但没那么陡，
    // 这样怠速能听见、满油又不至于炸耳
    const motorLevel = this.prefs.motors ? 0.62 * Math.pow(spin, 1.45) * (fpv ? 1.12 : 1) : 0
    this.motorBus?.gain.setTargetAtTime(motorLevel, now, tc)
    this.motorLp?.frequency.setTargetAtTime(700 + 2600 * Math.min(1, spin), now, tc)

    const propLevel = this.prefs.motors ? 0.34 * Math.pow(spin, 2) : 0
    this.propGain?.gain.setTargetAtTime(propLevel, now, tc)

    const sn = Math.min(1, Math.max(0, Math.abs(frame.speed) / 26))
    const windLevel = this.prefs.wind ? 0.26 * Math.pow(sn, 1.3) * (fpv ? 0.8 : 1) : 0
    this.windGain?.gain.setTargetAtTime(windLevel, now, 0.12)
    this.windLp?.frequency.setTargetAtTime(320 + 1500 * sn, now, 0.12)

    this.stats.spin = spin
    this.stats.freq = freq
    this.stats.motor = motorLevel
    this.stats.prop = propLevel
    this.stats.wind = windLevel
  }

  /** 擦碰 / 弹开：一声短促的爆响，强度 0..1 */
  bump(intensity = 1): void {
    const ctx = this.ctx
    if (!ctx || !this.noiseBuf || !this.master || !this.prefs.fx || ctx.state !== 'running') return
    const k = Math.min(1, Math.max(0.1, intensity))
    const t = ctx.currentTime
    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.playbackRate.value = 1.4
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1300
    bp.Q.value = 1.1
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(0.24 * k, t + 0.006)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.17)
    src.connect(bp)
    bp.connect(g)
    g.connect(this.master)
    src.start(t)
    src.stop(t + 0.22)

    const thump = ctx.createOscillator()
    thump.type = 'sine'
    thump.frequency.setValueAtTime(98, t)
    thump.frequency.exponentialRampToValueAtTime(52, t + 0.12)
    const tg = ctx.createGain()
    tg.gain.setValueAtTime(0.2 * k, t)
    tg.gain.exponentialRampToValueAtTime(0.0001, t + 0.14)
    thump.connect(tg)
    tg.connect(this.master)
    thump.start(t)
    thump.stop(t + 0.16)
    this.stats.fx += 1
  }

  /** 解体爆炸：低频冲击 + 由亮变闷的噪声尾巴 + 一小段金属碎屑 */
  explode(power = 1): void {
    const ctx = this.ctx
    if (!ctx || !this.noiseBuf || !this.master || !this.prefs.fx || ctx.state !== 'running') return
    const k = Math.min(2.2, Math.max(0.6, power))
    const t = ctx.currentTime
    // 电机立即掐断：8 Hz 的遥测更新来不及，炸了还在嗡就出戏了
    this.motorBus?.gain.setTargetAtTime(0, t, 0.03)
    this.propGain?.gain.setTargetAtTime(0, t, 0.03)
    this.whineGain?.gain.setTargetAtTime(0, t, 0.03)

    const src = ctx.createBufferSource()
    src.buffer = this.noiseBuf
    src.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 0.9
    lp.frequency.setValueAtTime(4200, t)
    lp.frequency.exponentialRampToValueAtTime(90, t + 1.3)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(0.62 * k, t + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7)
    src.connect(lp)
    lp.connect(g)
    g.connect(this.master)
    src.start(t)
    src.stop(t + 1.8)

    const sub = ctx.createOscillator()
    sub.type = 'sine'
    sub.frequency.setValueAtTime(74, t)
    sub.frequency.exponentialRampToValueAtTime(26, t + 0.85)
    const sg = ctx.createGain()
    sg.gain.setValueAtTime(0.5 * k, t)
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.0)
    sub.connect(sg)
    sg.connect(this.master)
    sub.start(t)
    sub.stop(t + 1.05)

    const crack = ctx.createBufferSource()
    crack.buffer = this.noiseBuf
    crack.playbackRate.value = 2.1
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 2600
    const cg = ctx.createGain()
    cg.gain.setValueAtTime(0.22 * k, t)
    cg.gain.exponentialRampToValueAtTime(0.0001, t + 0.26)
    crack.connect(hp)
    hp.connect(cg)
    cg.connect(this.master)
    crack.start(t)
    crack.stop(t + 0.3)

    this.stats.fx += 1
  }

  /** 界面提示音：很轻的一下，用于镜头切换、模式切换、特技起手 */
  blip(freq = 880, dur = 0.06, gain = 0.05): void {
    const ctx = this.ctx
    if (!ctx || !this.master || !this.prefs.fx || ctx.state !== 'running') return
    const t = ctx.currentTime
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(freq, t)
    osc.frequency.exponentialRampToValueAtTime(freq * 0.82, t + dur)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(gain, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(g)
    g.connect(this.master)
    osc.start(t)
    osc.stop(t + dur + 0.02)
  }

  /** 解锁成功的「上电」提示：两声上行短音，告诉用户声音链路真的通了 */
  private armCue(): void {
    this.blip(660, 0.07, 0.045)
    window.setTimeout(() => this.blip(990, 0.09, 0.04), 95)
  }

  /** 复位：清掉上一轮的事件计数，方便自检按轮次断言 */
  reset(): void {
    this.stats.fx = 0
    this.update({ ...this.frame, rpms: [0, 0, 0, 0], speed: 0, crashed: false })
  }

  /**
   * 释放音频图。这里刻意不把实例「作废」：场景组件被卸载再重建时，
   * 同一个引擎实例还会被重新 arm()，此时应当能重新建图继续出声，
   * 而不是留下一颗死掉的 AudioContext。
   */
  dispose(): void {
    const ctx = this.ctx
    // 摘掉手势监听：场景组件卸载再重建时会重新 arm()，旧监听留着会叠加
    if (this.gestureHandler) {
      window.removeEventListener('pointerdown', this.gestureHandler)
      window.removeEventListener('keydown', this.gestureHandler)
      window.removeEventListener('touchstart', this.gestureHandler)
      this.gestureHandler = null
    }
    try {
      this.noiseSrc?.stop()
    } catch {
      /* 已经停过 */
    }
    this.ctx = null
    this.master = null
    this.analyserNode = null
    this.noiseSrc = null
    this.noiseBuf = null
    this.voices = []
    this.stats = { built: false, spin: 0, freq: 0, motor: 0, prop: 0, wind: 0, master: 0, fx: 0 }
    this.armed = false
    if (ctx && ctx.state !== 'closed') void ctx.close()
  }

  debug(): Record<string, unknown> {
    return {
      state: this.ctx?.state ?? 'none',
      ready: this.ready,
      built: this.stats.built,
      spin: Number(this.stats.spin.toFixed(3)),
      freq: Number(this.stats.freq.toFixed(1)),
      motor: Number(this.stats.motor.toFixed(3)),
      prop: Number(this.stats.prop.toFixed(3)),
      wind: Number(this.stats.wind.toFixed(3)),
      master: Number(this.stats.master.toFixed(3)),
      fx: this.stats.fx,
      prefs: { ...this.prefs },
      voices: this.voices.length,
      analyser: !!this.analyserNode,
    }
  }
}
