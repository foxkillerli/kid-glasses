import {
  AudioInputSource,
  CreateStartUpPageContainer,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { DisplayQueue, type Layout, type TextBox } from './lib/display'
import { classify, type Gesture } from './lib/events'
import { RingLog, MemoryKV, type KV } from './lib/ringlog'
import { PcmAccumulator, clipStats, formatDb, levelBar, toDbfs, bytesToSeconds, type ClipStats } from './lib/audio'
import { newHeartbeat, tick, expectedTicks, lostTicks, formatDuration, hhmm, hhmmss, type HeartbeatState } from './lib/heartbeat'
import { WsProbe } from './lib/ws-probe'
import { paginateLines } from './lib/paginate'
import { SCREEN_W, SCREEN_H } from './lib/limits'
import {
  COMMON_HANZI,
  PUNCT_SAMPLES,
  WIDTH_SAMPLES,
  MIXED_SAMPLES,
  RARE_SAMPLES,
  hanziLines,
  sampleLines,
  mixedLines,
} from './content/glyphs'
import { capacityPages, type CapacityPage } from './content/capacity'

export const APP_NAME = 'kid-glasses'
export const PUBLIC_ECHO_URL = 'wss://echo.websocket.org'

export function echoUrlFor(loc: { protocol: string; host: string; hostname: string }): string {
  const local = loc.hostname === 'localhost' || loc.hostname === '127.0.0.1'
  if (loc.protocol === 'https:' && !local) return `wss://${loc.host}/echo`
  return PUBLIC_ECHO_URL
}
const HEARTBEAT_MS = 1000
const WS_PING_MS = 5000
const BODY_MAX_LINES = 7
const PAGE_MAX_BYTES = 900

export const ID = { cap: 1, status: 2, body: 3, hint: 4, full: 5 } as const
const STATUS_H = 32
const HINT_H = 32
const BODY_Y = STATUS_H
const BODY_H = SCREEN_H - STATUS_H - HINT_H
const FULL_PAD = 4
export const FULL_GEOMETRY = `${SCREEN_W}x${SCREEN_H} pad${FULL_PAD}`

function captureBox(): TextBox {
  return { id: ID.cap, name: 'cap', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H, content: ' ', capture: true, padding: 0 }
}

export function standardLayout(key: string, status: string, body: string, hint: string): Layout {
  return {
    key,
    boxes: [
      captureBox(),
      { id: ID.status, name: 'status', x: 0, y: 0, w: SCREEN_W, h: STATUS_H, content: status, padding: 2 },
      { id: ID.body, name: 'body', x: 0, y: BODY_Y, w: SCREEN_W, h: BODY_H, content: body, padding: 4 },
      { id: ID.hint, name: 'hint', x: 0, y: SCREEN_H - HINT_H, w: SCREEN_W, h: HINT_H, content: hint, padding: 2 },
    ],
  }
}

export function fullLayout(key: string, body: string): Layout {
  return {
    key,
    boxes: [
      captureBox(),
      { id: ID.full, name: 'full', x: 0, y: 0, w: SCREEN_W, h: SCREEN_H, content: body, padding: FULL_PAD },
    ],
  }
}

export interface GlyphPage {
  title: string
  lines: string[]
}

export function glyphPages(): GlyphPage[] {
  const pages: GlyphPage[] = []
  const opts = { maxLines: BODY_MAX_LINES, maxBytes: PAGE_MAX_BYTES }
  const hanzi = paginateLines(hanziLines(COMMON_HANZI), opts)
  hanzi.forEach((lines, i) => pages.push({ title: `Hanzi ${i + 1}/${hanzi.length}`, lines }))
  for (const [title, lines] of [
    ['Punct', sampleLines(PUNCT_SAMPLES, 6)],
    ['Full/half', sampleLines(WIDTH_SAMPLES, 5)],
    ['Mixed', mixedLines(MIXED_SAMPLES)],
    ['Rare', sampleLines(RARE_SAMPLES, 6)],
  ] as const) {
    const chunks = paginateLines([...lines], opts)
    chunks.forEach((l, i) => pages.push({ title: chunks.length > 1 ? `${title} ${i + 1}/${chunks.length}` : title, lines: l }))
  }
  return pages
}

type Screen =
  | { kind: 'menu'; cursor: number }
  | { kind: 'glyph'; page: number }
  | { kind: 'cap'; page: number }
  | { kind: 'mic' }
  | { kind: 'bg' }

const MENU: Array<{ label: string; open: () => Screen }> = [
  { label: 'Glyph test (CJK)', open: () => ({ kind: 'glyph', page: 0 }) },
  { label: 'Page capacity', open: () => ({ kind: 'cap', page: 0 }) },
  { label: 'Mic capture', open: () => ({ kind: 'mic' }) },
  { label: 'Background probe', open: () => ({ kind: 'bg' }) },
]

interface MicState {
  recording: boolean
  source: AudioInputSource
  mode: 'long' | 'tap'
  startedAt: number
  acc: PcmAccumulator | null
  last: ClipStats | null
  lastSource: AudioInputSource | null
  lastControl: string
  framesWhileIdle: number
  lastLongEndAt: number
}

interface BootInfo {
  boot: number
  bootAt: number
  prevLastTickAt: number
  prevBoot: number
}

export interface Mirror {
  render(layout: Layout | null, extra: string): void
}

export class App {
  private readonly display: DisplayQueue
  private readonly log: RingLog
  private readonly kv: KV
  private screen: Screen = { kind: 'menu', cursor: 0 }
  private readonly glyphs = glyphPages()
  private readonly caps: CapacityPage[] = capacityPages(FULL_GEOMETRY)
  private hb: HeartbeatState
  private readonly bootInfo: BootInfo
  private readonly ws: WsProbe
  private readonly mic: MicState = {
    recording: false,
    source: AudioInputSource.Glasses,
    mode: 'tap',
    startedAt: 0,
    acc: null,
    last: null,
    lastSource: null,
    lastControl: '-',
    framesWhileIdle: 0,
    lastLongEndAt: 0,
  }
  private created = false
  private lastGesture = '-'
  private eventsSeen = 0

  constructor(
    private readonly bridge: EvenAppBridge,
    private readonly mirror: Mirror,
    storage: KV | null,
  ) {
    this.kv = storage ?? new MemoryKV()
    this.log = new RingLog(this.kv, 'kg.log', 1000)
    this.bootInfo = this.registerBoot()
    this.hb = newHeartbeat(Date.now())
    this.display = new DisplayQueue({
      rebuild: layout => this.sendLayout(layout),
      upgrade: box =>
        this.bridge.textContainerUpgrade(
          new TextContainerUpgrade({ containerID: box.id, containerName: box.name, content: box.content }),
        ),
    })
    this.display.onRebuildFailed = key => {
      this.note(`rebuild ${key} failed (${this.display.lastError || 'false'}), will retry`)
      if (this.pendingKey === key) this.pendingKey = ''
    }
    this.ws = new WsProbe({
      url: echoUrlFor(window.location),
      pingEveryMs: WS_PING_MS,
      reconnectMs: 3000,
      now: () => Date.now(),
      log: m => this.note(m),
    })
  }

  private registerBoot(): BootInfo {
    const prevBoot = Number(this.kv.getItem('kg.boot') ?? '0') || 0
    let prevLastTickAt = 0
    try {
      const prevHb = JSON.parse(this.kv.getItem('kg.hb') ?? 'null') as HeartbeatState | null
      prevLastTickAt = prevHb?.lastTickAt ?? 0
    } catch {
      prevLastTickAt = 0
    }
    const boot = prevBoot + 1
    this.kv.setItem('kg.boot', String(boot))
    return { boot, bootAt: Date.now(), prevLastTickAt, prevBoot }
  }

  note(message: string): void {
    const e = this.log.add(Date.now(), this.bootInfo.boot, message)
    console.log(`[kg] ${hhmmss(e.t)} b${e.b} ${e.m}`)
  }

  async start(): Promise<void> {
    const w = window as unknown as Record<string, unknown>
    const since = this.bootInfo.prevLastTickAt ? ` prevBoot#${this.bootInfo.prevBoot} lastTick ${formatDuration(this.bootInfo.bootAt - this.bootInfo.prevLastTickAt)} ago` : ''
    this.note(`BOOT #${this.bootInfo.boot}${since} vis=${document.visibilityState} snapHook=${typeof w.__getStateSnapshot} restoreHook=${typeof w.__restoreState}`)
    this.installLifecycleLogging()
    this.bridge.onEvenHubEvent(ev => this.onEvent(ev))
    this.render()
    setInterval(() => this.onHeartbeat(), HEARTBEAT_MS)
    setInterval(() => this.onMicRefresh(), 250)
    this.ws.start()
  }

  private installLifecycleLogging(): void {
    document.addEventListener('visibilitychange', () => {
      this.note(`visibility=${document.visibilityState}`)
      if (document.visibilityState === 'visible') this.forceRedraw()
    })
    window.addEventListener('pagehide', e => this.note(`pagehide persisted=${(e as PageTransitionEvent).persisted}`))
    window.addEventListener('pageshow', e => this.note(`pageshow persisted=${(e as PageTransitionEvent).persisted}`))
    document.addEventListener('freeze', () => this.note('freeze'))
    document.addEventListener('resume', () => this.note('resume'))
    window.addEventListener('online', () => this.note('online'))
    window.addEventListener('offline', () => this.note('offline'))
    window.addEventListener('focus', () => this.note('window focus'))
    window.addEventListener('blur', () => this.note('window blur'))
    try {
      this.bridge.onLaunchSource(src => this.note(`launchSource=${src}`))
    } catch (err) {
      this.note(`onLaunchSource failed ${String(err).slice(0, 40)}`)
    }
    let lastStatus = ''
    try {
      this.bridge.onDeviceStatusChanged(st => {
        const s = `conn=${st.connectType} wear=${st.isWearing} bat=${st.batteryLevel} chg=${st.isCharging} case=${st.isInCase}`
        if (s !== lastStatus) this.note(`device ${s}`)
        lastStatus = s
      })
    } catch (err) {
      this.note(`onDeviceStatusChanged failed ${String(err).slice(0, 40)}`)
    }
  }

  private async sendLayout(layout: Layout): Promise<boolean> {
    const textObject = layout.boxes.map(
      b =>
        new TextContainerProperty({
          xPosition: b.x,
          yPosition: b.y,
          width: b.w,
          height: b.h,
          borderWidth: b.border ?? 0,
          borderColor: 5,
          paddingLength: b.padding ?? 0,
          containerID: b.id,
          containerName: b.name,
          content: b.content,
          isEventCapture: b.capture ? 1 : 0,
        }),
    )
    if (!this.created) {
      const res = await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({ containerTotalNum: textObject.length, textObject }),
      )
      this.note(`createStartUpPageContainer -> ${String(res)}`)
      this.created = true
      if (Number(res) === 0) return true
      const rebuilt = await this.bridge.rebuildPageContainer(
        new RebuildPageContainer({ containerTotalNum: textObject.length, textObject }),
      )
      this.note(`create failed, fallback rebuildPageContainer -> ${rebuilt}`)
      return rebuilt
    }
    const ok = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: textObject.length, textObject }),
    )
    if (!ok) this.note(`rebuildPageContainer(${layout.key}) -> false`)
    return ok
  }

  private pageName(): string {
    switch (this.screen.kind) {
      case 'menu':
        return 'Menu'
      case 'glyph':
        return `${this.glyphs[this.screen.page].title} (${this.screen.page + 1}/${this.glyphs.length})`
      case 'cap':
        return this.caps[this.screen.page].title
      case 'mic':
        return 'Mic'
      case 'bg':
        return 'BG probe'
    }
  }

  private statusLine(): string {
    return `${APP_NAME} · ${this.pageName()} · ${hhmm(Date.now())}`
  }

  private layoutKey(): string {
    const s = this.screen
    return s.kind === 'glyph' || s.kind === 'cap' ? `${s.kind}:${s.page}` : s.kind
  }

  private render(): void {
    const key = this.layoutKey()
    const s = this.screen
    let layout: Layout
    if (s.kind === 'cap' && this.caps[s.page].fullscreen) {
      layout = fullLayout(key, this.caps[s.page].body)
    } else {
      layout = standardLayout(key, this.statusLine(), this.bodyText(), this.hintText())
    }
    if (this.pendingKey !== key) {
      this.pendingKey = key
      this.display.setLayout(layout)
    } else {
      for (const b of layout.boxes) if (b.id !== ID.cap) this.display.setText(b.id, b.content)
    }
    this.mirror.render(layout, this.mirrorExtra())
  }

  private pendingKey = ''

  private forceRedraw(): void {
    this.pendingKey = ''
    this.render()
  }

  private refresh(): void {
    const key = this.layoutKey()
    if (this.pendingKey !== key) return this.render()
    const s = this.screen
    if (s.kind === 'cap' && this.caps[s.page].fullscreen) {
      this.mirror.render(this.display.layout, this.mirrorExtra())
      return
    }
    this.display.setText(ID.status, this.statusLine())
    if (s.kind === 'mic' || s.kind === 'bg') this.display.setText(ID.body, this.bodyText())
    this.display.setText(ID.hint, this.hintText())
    this.mirror.render(standardLayout(key, this.statusLine(), this.bodyText(), this.hintText()), this.mirrorExtra())
  }

  private hintText(): string {
    switch (this.screen.kind) {
      case 'menu':
        return 'swipe: move  tap: open  2tap: exit'
      case 'glyph':
        return 'swipe dn: next  up: prev  2tap: menu'
      case 'cap':
        return 'swipe dn: next  up: prev  2tap: menu'
      case 'mic':
        return this.mic.recording ? 'release / tap: stop' : 'hold: rec  tap: toggle  swipe: mic src  2tap: menu'
      case 'bg':
        return 'tap: WS reconnect  hold: clear log  2tap: menu'
    }
  }

  private bodyText(): string {
    const s = this.screen
    switch (s.kind) {
      case 'menu':
        return [
          'Hello Fox! M0 device probes',
          ...MENU.map((m, i) => `${i === s.cursor ? '>' : ' '} ${i + 1}. ${m.label}`),
          `boot #${this.bootInfo.boot}  last: ${this.lastGesture}`,
        ].join('\n')
      case 'glyph':
        return this.glyphs[s.page].lines.join('\n')
      case 'cap':
        return this.caps[s.page].body
      case 'mic':
        return this.micBody()
      case 'bg':
        return this.bgBody(4)
    }
  }

  private micBody(): string {
    const m = this.mic
    const src = m.source === AudioInputSource.Glasses ? 'GLASSES' : 'PHONE'
    const lines: string[] = []
    if (m.recording && m.acc) {
      const db = toDbfs(m.acc.lastFrameRms)
      lines.push(`● REC ${src} (${m.mode})  ${bytesToSeconds(m.acc.totalBytes).toFixed(1)}s`)
      lines.push(`bytes ${m.acc.totalBytes}  frames ${m.acc.frames}`)
      lines.push(`${levelBar(db)} ${formatDb(db)}dB`)
      lines.push(`rms ${Math.round(m.acc.lastFrameRms)}  wall ${((Date.now() - m.startedAt) / 1000).toFixed(1)}s`)
      lines.push(`audioControl -> ${m.lastControl}`)
    } else {
      lines.push(`○ idle  src: ${src}`)
      lines.push(`audioControl -> ${m.lastControl}`)
    }
    if (m.last) {
      const c = m.last
      const lsrc = m.lastSource === AudioInputSource.Phone ? 'phone' : 'glasses'
      lines.push(`last(${lsrc}): ${c.seconds.toFixed(2)}s ${c.bytes}B ${c.frames}fr`)
      lines.push(`rms ${formatDb(c.rmsDb)}dB peak ${formatDb(c.peakDb)}dB`)
    } else {
      lines.push('last clip: none')
    }
    if (m.framesWhileIdle > 0) lines.push(`idle frames: ${m.framesWhileIdle}`)
    return lines.slice(0, BODY_MAX_LINES).join('\n')
  }

  private bgBody(logLines: number): string {
    const now = Date.now()
    const st = this.ws.stats
    const exp = expectedTicks(this.hb, now, HEARTBEAT_MS)
    const lines = [
      `ticks ${this.hb.ticks}/${exp} lost ${lostTicks(this.hb, now, HEARTBEAT_MS)} maxgap ${(this.hb.maxGapMs / 1000).toFixed(1)}s`,
      `WS ${st.state} pong ${st.pongs}/${st.pingsSent} rtt ${st.lastRttMs}ms re${Math.max(0, st.opens - 1)}`,
      `boot #${this.bootInfo.boot} up ${formatDuration(now - this.hb.startedAt)} log ${this.log.size}`,
    ]
    for (const e of this.log.last(logLines)) lines.push(`${hhmmss(e.t)} ${e.m}`.slice(0, 44))
    return lines.join('\n')
  }

  private mirrorExtra(): string {
    const lines = [
      `events seen: ${this.eventsSeen}  last gesture: ${this.lastGesture}`,
      `display writes: ${this.display.writes}  failures: ${this.display.failures}  timeouts: ${this.display.timeouts} ${this.display.lastError}`,
      '',
      this.bgBody(0),
      '',
      '--- log (newest last) ---',
      ...this.log.last(40).map(e => `${hhmmss(e.t)} b${e.b} ${e.m}`),
    ]
    if (this.screen.kind === 'cap') lines.unshift(`HOW TO READ: ${this.caps[this.screen.page].howToRead}`, '')
    return lines.join('\n')
  }

  private onHeartbeat(): void {
    const now = Date.now()
    const r = tick(this.hb, now, HEARTBEAT_MS)
    this.hb = r.state
    if (r.isLongGap) this.note(`tick gap ${(r.gapMs / 1000).toFixed(1)}s at tick ${this.hb.ticks}`)
    if (this.hb.ticks % 30 === 0) this.note(`tick ${this.hb.ticks} exp ${expectedTicks(this.hb, now, HEARTBEAT_MS)}`)
    this.kv.setItem('kg.hb', JSON.stringify(this.hb))
    this.refresh()
  }

  private onMicRefresh(): void {
    if (this.screen.kind === 'mic' && this.mic.recording) this.refresh()
  }

  private onEvent(ev: EvenHubEvent): void {
    if (ev.audioEvent) {
      this.onAudio(ev.audioEvent.audioPcm)
      return
    }
    if (ev.menuItemClickEvent) {
      this.note(`menuItemClick ${JSON.stringify(ev.menuItemClickEvent).slice(0, 60)}`)
      return
    }
    const c = classify(ev)
    if (!c) {
      this.note(`unclassified event ${JSON.stringify(ev.jsonData ?? ev).slice(0, 80)}`)
      return
    }
    if (c.gesture === 'imu') return
    this.eventsSeen++
    const src = ev.sysEvent?.eventSource
    this.lastGesture = `${c.gesture}(${c.via}${src !== undefined ? ' src' + src : ''})`
    if (['fgEnter', 'fgExit', 'abnormalExit', 'systemExit', 'longStart', 'longEnd'].includes(c.gesture)) {
      this.note(`event ${this.lastGesture}`)
    }
    this.onGesture(c.gesture)
  }

  private onAudio(pcm: Uint8Array | undefined): void {
    if (!pcm) return
    if (this.mic.recording && this.mic.acc) {
      this.mic.acc.push(pcm)
    } else {
      this.mic.framesWhileIdle++
    }
  }

  private onGesture(g: Gesture): void {
    switch (g) {
      case 'fgEnter':
        if (this.mic.recording) {
          this.note('fgEnter while recording -> re-arm audioControl')
          void this.bridge.audioControl(true, this.mic.source).then(r => this.note(`re-arm audioControl -> ${r}`))
        }
        this.forceRedraw()
        return
      case 'fgExit':
        this.kv.setItem('kg.hb', JSON.stringify(this.hb))
        return
      case 'abnormalExit':
      case 'systemExit':
        if (this.mic.recording) void this.stopRecording('exit')
        return
      default:
        break
    }
    const s = this.screen
    if (g === 'double') {
      if (s.kind === 'menu') {
        this.note('double on menu -> shutDownPageContainer(1)')
        void this.bridge.shutDownPageContainer(1)
        return
      }
      if (s.kind === 'mic' && this.mic.recording) void this.stopRecording('leave')
      this.screen = { kind: 'menu', cursor: MENU.findIndex(m => m.open().kind === s.kind) }
      this.render()
      return
    }
    switch (s.kind) {
      case 'menu':
        if (g === 'down') s.cursor = (s.cursor + 1) % MENU.length
        else if (g === 'up') s.cursor = (s.cursor + MENU.length - 1) % MENU.length
        else if (g === 'click') this.screen = MENU[s.cursor].open()
        break
      case 'glyph':
        if (g === 'down') s.page = (s.page + 1) % this.glyphs.length
        else if (g === 'up') s.page = (s.page + this.glyphs.length - 1) % this.glyphs.length
        break
      case 'cap':
        if (g === 'down') s.page = (s.page + 1) % this.caps.length
        else if (g === 'up') s.page = (s.page + this.caps.length - 1) % this.caps.length
        break
      case 'mic':
        this.onMicGesture(g)
        break
      case 'bg':
        if (g === 'click') this.ws.reconnectNow()
        else if (g === 'longStart') {
          this.log.clear()
          this.hb = newHeartbeat(Date.now())
          this.note('log cleared, heartbeat reset')
        }
        break
    }
    this.render()
  }

  private onMicGesture(g: Gesture): void {
    const m = this.mic
    if (g === 'longStart') {
      if (!m.recording) void this.startRecording('long')
    } else if (g === 'longEnd') {
      m.lastLongEndAt = Date.now()
      if (m.recording && m.mode === 'long') void this.stopRecording('release')
    } else if (g === 'click') {
      if (Date.now() - m.lastLongEndAt < 700) return
      if (m.recording) void this.stopRecording('tap')
      else void this.startRecording('tap')
    } else if ((g === 'up' || g === 'down') && !m.recording) {
      m.source = m.source === AudioInputSource.Glasses ? AudioInputSource.Phone : AudioInputSource.Glasses
      this.note(`mic source -> ${m.source}`)
    }
  }

  private async startRecording(mode: 'long' | 'tap'): Promise<void> {
    const m = this.mic
    m.recording = true
    m.mode = mode
    m.startedAt = Date.now()
    m.acc = new PcmAccumulator(120)
    m.framesWhileIdle = 0
    m.lastControl = 'pending'
    this.render()
    let r: unknown
    try {
      r = await this.bridge.audioControl(true, m.source)
    } catch (err) {
      r = `throw ${String(err).slice(0, 40)}`
    }
    m.lastControl = `open ${String(r)}`
    this.note(`rec start ${mode} src=${m.source} audioControl -> ${String(r)}`)
    this.render()
  }

  private async stopRecording(reason: string): Promise<void> {
    const m = this.mic
    if (!m.recording) return
    m.recording = false
    let r: unknown
    try {
      r = await this.bridge.audioControl(false)
    } catch (err) {
      r = `throw ${String(err).slice(0, 40)}`
    }
    m.lastControl = `close ${String(r)}`
    if (m.acc) {
      m.last = clipStats(m.acc)
      m.lastSource = m.source
      const c = m.last
      this.note(
        `rec stop ${reason} ${c.seconds.toFixed(2)}s ${c.bytes}B ${c.frames}fr wall ${((Date.now() - m.startedAt) / 1000).toFixed(2)}s rms ${formatDb(c.rmsDb)} peak ${formatDb(c.peakDb)}`,
      )
    }
    this.render()
  }

  lastClipSamples(): Int16Array | null {
    return this.mic.acc ? this.mic.acc.samples() : null
  }
}
