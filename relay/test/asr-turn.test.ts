import { describe, expect, it } from 'vitest'
import { AsrTurn, type AsrLimits, type AsrOutcome } from '../src/asr-turn'
import { CLOSE_STREAM, DeepgramUpgradeError, FINALIZE, KEEP_ALIVE, type AsrLang } from '../src/deepgram'
import { FakeAsr, FakeTimers, flush } from './fakes'

type Next = FakeAsr | Error | 'hang'

function turn(queue: Next[], o: { lang?: AsrLang; limits?: Partial<AsrLimits> } = {}) {
  const timers = new FakeTimers()
  const connects: Array<{ lang: AsrLang; fallback: boolean }> = []
  const partials: string[] = []
  const outcomes: AsrOutcome[] = []
  const logs: string[] = []
  const signals: Array<AbortSignal | undefined> = []
  const t = new AsrTurn({
    connector: {
      connect: (lang, fallback, signal) => {
        connects.push({ lang, fallback })
        signals.push(signal)
        const next = queue.shift() ?? new Error('no more sockets')
        if (next === 'hang') return new Promise(() => {})
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
      },
    },
    lang: o.lang ?? 'auto',
    timers,
    now: () => timers.now,
    limits: o.limits,
    log: m => logs.push(m),
    onPartial: p => partials.push(p),
    onDone: r => outcomes.push(r),
  })
  return { t, timers, connects, partials, outcomes, logs, signals }
}

const frame = (ms: number, fill = 1) => new Uint8Array(ms * 32).fill(fill)

describe('AsrTurn (Deepgram streaming turn)', () => {
  it('streams audio, shows growing partials, sends Finalize on stop and posts as soon as the from_finalize result arrives', async () => {
    const dg = new FakeAsr()
    const { t, timers, partials, outcomes, logs, connects } = turn([dg])
    await t.start()
    expect(connects).toEqual([{ lang: 'auto', fallback: false }])
    const a = frame(100)
    t.push(a)
    expect(dg.audio()).toEqual([a])
    dg.result('今天', false)
    dg.result('今天几点', true, { start: 0, duration: 0.1 })
    timers.advance(400)
    t.stop('device')
    expect(dg.texts()).toEqual([FINALIZE])
    t.push(frame(100))
    expect(dg.audio()).toHaveLength(1)
    dg.result('放学', true, { start: 0.1, duration: 0.3, fromFinalize: true })
    expect(partials).toEqual(['今天', '今天几点', '今天几点放学'])
    expect(outcomes).toEqual([{ ok: true, text: '今天几点放学', reason: 'finalize' }])
    expect(dg.texts()).toEqual([FINALIZE, CLOSE_STREAM])
    expect(dg.closedWith).toBe(1000)
    expect(timers.pending).toBe(0)
    const done = logs.find(l => l.startsWith('asr done'))
    expect(done).toBe('asr done reason=finalize lang=auto bytes=3200 frames=1 audioMs=100 firstPartialMs=0 finalMs=0 retries=0 fallback=0 close=none len=6')
    expect(logs.join('\n')).not.toMatch(/今天|放学/)
  })

  it('without a from_finalize result it sends CloseStream after 1.5 s and completes on the normal close', async () => {
    const dg = new FakeAsr()
    const { t, timers, outcomes } = turn([dg])
    await t.start()
    t.push(frame(100))
    dg.result('hello', true, { start: 0, duration: 0.1 })
    t.stop('device')
    timers.advance(1499)
    expect(dg.texts()).toEqual([FINALIZE])
    timers.advance(1)
    expect(dg.texts()).toEqual([FINALIZE, CLOSE_STREAM])
    dg.result('world', true, { start: 0.1, duration: 0.2 })
    dg.close(1000)
    expect(outcomes).toEqual([{ ok: true, text: 'hello world', reason: 'close' }])
  })

  it('a close with Metadata seen counts as complete even if the close code is not 1000', async () => {
    const dg = new FakeAsr()
    const { t, timers, outcomes } = turn([dg])
    await t.start()
    t.push(frame(100))
    dg.result('好的', true, { start: 0, duration: 0.1 })
    t.stop('device')
    timers.advance(1500)
    dg.emit('message', { data: JSON.stringify({ type: 'Metadata', duration: 0.1 }) })
    dg.close(1005)
    expect(outcomes).toEqual([{ ok: true, text: '好的', reason: 'close' }])
  })

  it('if Deepgram never answers after stop, it posts what the lens showed (finals plus the last interim) after 5 s', async () => {
    const dg = new FakeAsr()
    const { t, timers, outcomes, logs } = turn([dg])
    await t.start()
    t.push(frame(100))
    dg.result('我想', true, { start: 0, duration: 0.05 })
    dg.result('吃饭', false)
    t.stop('device')
    timers.advance(4999)
    expect(outcomes).toEqual([])
    timers.advance(1)
    expect(outcomes).toEqual([{ ok: true, text: '我想吃饭', reason: 'timeout' }])
    expect(logs.some(l => l.startsWith('asr done reason=timeout'))).toBe(true)
    expect(timers.pending).toBe(0)
  })

  it('an empty final is reported as an empty transcript', async () => {
    const dg = new FakeAsr()
    const { t, outcomes } = turn([dg])
    await t.start()
    t.push(frame(100, 0))
    t.stop('device')
    dg.result('', true, { start: 0, duration: 0.1, fromFinalize: true })
    expect(outcomes).toEqual([{ ok: true, text: '', reason: 'finalize' }])
  })

  it('UtteranceEnd and unknown messages are ignored', async () => {
    const dg = new FakeAsr()
    const { t, partials, outcomes } = turn([dg])
    await t.start()
    dg.emit('message', { data: JSON.stringify({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: 1.2 }) })
    dg.emit('message', { data: JSON.stringify({ type: 'SpeechStarted' }) })
    dg.emit('message', { data: 'garbage' })
    expect(partials).toEqual([])
    expect(outcomes).toEqual([])
  })

  it('sends a KeepAlive text frame only after 3 s without audio going to Deepgram', async () => {
    const dg = new FakeAsr()
    const { t, timers } = turn([dg])
    await t.start()
    t.push(frame(100))
    timers.advance(2000)
    expect(dg.texts()).toEqual([])
    timers.advance(1000)
    expect(dg.texts()).toEqual([KEEP_ALIVE])
    for (let i = 0; i < 5; i++) {
      t.push(frame(100))
      timers.advance(1000)
    }
    expect(dg.texts()).toEqual([KEEP_ALIVE])
  })

  it('no audio from the glasses for 10 s while talking fails the turn with asr-no-audio', async () => {
    const dg = new FakeAsr()
    const { t, timers, outcomes } = turn([dg])
    await t.start()
    t.push(frame(100))
    timers.advance(9000)
    expect(outcomes).toEqual([])
    timers.advance(1000)
    expect(outcomes).toEqual([{ ok: false, code: 'asr-no-audio', message: 'no audio from the glasses' }])
    expect(dg.closedWith).toBe(1000)
  })

  it('stops the turn itself when audio exceeds the maximum length', async () => {
    const dg = new FakeAsr()
    const { t, logs } = turn([dg], { limits: { maxAudioMs: 300 } })
    await t.start()
    for (let i = 0; i < 3; i++) t.push(frame(100))
    t.push(frame(100))
    expect(dg.audio()).toHaveLength(3)
    expect(dg.texts()).toEqual([FINALIZE])
    expect(t.stopping).toBe(true)
    expect(logs).toContain('asr stop (max-length)')
  })

  it('a mid-stream drop reconnects and replays only the audio Deepgram had not finalized, so no segment repeats', async () => {
    const dg1 = new FakeAsr()
    const dg2 = new FakeAsr()
    const { t, timers, outcomes, partials, logs } = turn([dg1, dg2])
    await t.start()
    const a = frame(100, 1)
    const b = frame(100, 2)
    t.push(a)
    t.push(b)
    dg1.result('第一句', true, { start: 0, duration: 0.15 })
    dg1.result('第二', false)
    dg1.close(1011)
    expect(outcomes).toEqual([])
    const c = frame(100, 3)
    t.push(c)
    timers.advance(300)
    await flush()
    expect(dg2.audio()).toEqual([b.subarray(1600), c])
    const d = frame(100, 4)
    t.push(d)
    expect(dg2.audio().at(-1)).toEqual(d)
    dg2.result('第二句', true, { start: 0, duration: 0.25 })
    t.stop('device')
    dg2.result('', true, { start: 0.25, duration: 0, fromFinalize: true })
    expect(outcomes).toEqual([{ ok: true, text: '第一句第二句', reason: 'finalize' }])
    expect(partials).toEqual(['第一句', '第一句第二', '第一句第二句'])
    expect(logs).toContain('asr retry n=1 reason=close close=1011')
    expect(logs.find(l => l.startsWith('asr done'))).toContain('retries=1')
    expect(logs.join('\n')).not.toMatch(/第一句|第二/)
  })

  it('a drop while finalizing reconnects, replays and finalizes on the new socket', async () => {
    const dg1 = new FakeAsr()
    const dg2 = new FakeAsr()
    const { t, timers, outcomes } = turn([dg1, dg2])
    await t.start()
    const a = frame(100)
    t.push(a)
    t.stop('device')
    dg1.emit('error', {})
    timers.advance(300)
    await flush()
    expect(dg2.audio()).toEqual([a])
    expect(dg2.texts()).toEqual([FINALIZE])
    dg2.result('OK', true, { start: 0, duration: 0.1, fromFinalize: true })
    expect(outcomes).toEqual([{ ok: true, text: 'OK', reason: 'finalize' }])
  })

  it('retries are bounded: after 2 reconnects the turn fails with asr-interrupted', async () => {
    const socks = [new FakeAsr(), new FakeAsr(), new FakeAsr()]
    const { t, timers, outcomes, connects } = turn([...socks])
    await t.start()
    t.push(frame(100))
    for (const s of socks) {
      s.close(1011)
      timers.advance(300)
      await flush()
    }
    expect(connects).toHaveLength(3)
    expect(outcomes).toEqual([{ ok: false, code: 'asr-interrupted', message: 'transcription ended early; nothing was sent' }])
    expect(timers.pending).toBe(0)
  })

  it('if the unfinalized audio outgrew the retry buffer, a drop is reported instead of posting with a gap', async () => {
    const dg = new FakeAsr()
    const { t, outcomes, logs, connects } = turn([dg, new FakeAsr()], { limits: { retryBufferMs: 200 } })
    await t.start()
    for (let i = 0; i < 4; i++) t.push(frame(100))
    dg.close(1011)
    expect(outcomes).toEqual([{ ok: false, code: 'asr-interrupted', message: 'transcription ended early; nothing was sent' }])
    expect(logs).toContain('asr retry impossible buffer-overflow')
    expect(connects).toHaveLength(1)
  })

  it('HTTP 401/402/403 on connect fails at once with asr-rejected', async () => {
    for (const status of [401, 402, 403]) {
      const { t, outcomes, connects } = turn([new DeepgramUpgradeError(status)])
      await t.start()
      expect(outcomes).toEqual([{ ok: false, code: 'asr-rejected', message: `transcription service refused the request (http ${status})` }])
      expect(connects).toHaveLength(1)
    }
  })

  it('HTTP 400 on connect falls back once to the M1 URL', async () => {
    const dg = new FakeAsr()
    const { t, connects, logs } = turn([new DeepgramUpgradeError(400), dg], { lang: 'zh' })
    await t.start()
    await flush()
    expect(connects).toEqual([
      { lang: 'zh', fallback: false },
      { lang: 'zh', fallback: true },
    ])
    t.push(frame(100))
    expect(dg.audio()).toHaveLength(1)
    t.stop('device')
    dg.result('x', true, { fromFinalize: true })
    expect(logs).toContain('asr connect failed status=400 err=DeepgramUpgradeError fallback=0')
    expect(logs.find(l => l.startsWith('asr done'))).toContain('fallback=1')
  })

  it('a connect that hangs times out after 5 s and is retried; frames sent meanwhile are replayed', async () => {
    const dg = new FakeAsr()
    const { t, timers, connects, logs } = turn(['hang', dg])
    void t.start()
    const a = frame(100)
    t.push(a)
    timers.advance(5000)
    expect(logs).toContain('asr connect timeout')
    timers.advance(300)
    await flush()
    expect(connects).toHaveLength(2)
    expect(dg.audio()).toEqual([a])
  })

  it('if every connect fails the device gets asr-connect-failed', async () => {
    const { t, timers, outcomes, connects } = turn([new Error('net'), new DeepgramUpgradeError(503), new Error('net')])
    await t.start()
    for (let i = 0; i < 3; i++) {
      timers.advance(300)
      await flush()
    }
    expect(connects).toHaveLength(3)
    expect(outcomes).toEqual([{ ok: false, code: 'asr-connect-failed', message: 'could not reach the transcription service' }])
  })

  it('cancel is silent, closes the socket and clears every timer', async () => {
    const dg = new FakeAsr()
    const { t, timers, outcomes } = turn([dg])
    await t.start()
    t.push(frame(100))
    dg.result('不要了', false)
    t.cancel('device')
    expect(outcomes).toEqual([{ ok: false, code: null }])
    expect(dg.closedWith).toBe(1000)
    expect(timers.pending).toBe(0)
    dg.result('late', true, { fromFinalize: true })
    expect(outcomes).toHaveLength(1)
  })

  it('review M2-1: audio trimmed from the buffer while waiting to reconnect is detected at replay; nothing is posted with a gap', async () => {
    const dg1 = new FakeAsr()
    const dg2 = new FakeAsr()
    const { t, timers, outcomes, logs } = turn([dg1, dg2], { limits: { retryBufferMs: 300 } })
    await t.start()
    for (let i = 0; i < 3; i++) t.push(frame(100))
    dg1.close(1011)
    t.push(frame(100))
    timers.advance(300)
    await flush()
    expect(dg2.audio()).toEqual([])
    expect(outcomes).toEqual([{ ok: false, code: 'asr-interrupted', message: 'transcription ended early; nothing was sent' }])
    expect(logs).toContain('asr retry impossible buffer-overflow')
  })

  it('review M2-3: a hung upgrade is aborted on timeout, start() still resolves, and cancel aborts the attempt in flight', async () => {
    const { t, timers, signals } = turn(['hang', 'hang'])
    let settled = false
    void t.start().then(() => (settled = true))
    timers.advance(5000)
    await flush()
    expect(settled).toBe(true)
    expect(signals[0]?.aborted).toBe(true)
    timers.advance(300)
    await flush()
    expect(signals).toHaveLength(2)
    expect(signals[1]?.aborted).toBe(false)
    t.cancel('device')
    expect(signals[1]?.aborted).toBe(true)
    expect(timers.pending).toBe(0)
  })

  it('review M2-4: a normal close after Finalize but before CloseStream is retried instead of posting the interim', async () => {
    const dg1 = new FakeAsr()
    const dg2 = new FakeAsr()
    const { t, timers, outcomes } = turn([dg1, dg2])
    await t.start()
    const a = frame(100)
    t.push(a)
    dg1.result('差不多', false)
    t.stop('device')
    dg1.close(1000)
    expect(outcomes).toEqual([])
    timers.advance(300)
    await flush()
    expect(dg2.audio()).toEqual([a])
    expect(dg2.texts()).toEqual([FINALIZE])
    dg2.result('差不多了', true, { start: 0, duration: 0.1, fromFinalize: true })
    expect(outcomes).toEqual([{ ok: true, text: '差不多了', reason: 'finalize' }])
  })

  it('review R2: a 1000 close after Finalize with every byte finalized posts the finals even if reconnects would fail', async () => {
    const dg = new FakeAsr()
    const { t, outcomes } = turn([dg, new DeepgramUpgradeError(503), new DeepgramUpgradeError(503)])
    await t.start()
    t.push(frame(100))
    dg.result('都确认了', true, { start: 0, duration: 0.1 })
    t.stop('device')
    dg.close(1000)
    expect(outcomes).toEqual([{ ok: true, text: '都确认了', reason: 'close' }])
  })

  it('review R2: after CloseStream a close without a final for the last interim posts only confirmed text', async () => {
    const dg = new FakeAsr()
    const { t, timers, outcomes } = turn([dg])
    await t.start()
    t.push(frame(200))
    dg.result('确认的', true, { start: 0, duration: 0.1 })
    dg.result('没确认', false)
    t.stop('device')
    timers.advance(1500)
    dg.close(1000)
    expect(outcomes).toEqual([{ ok: true, text: '确认的', reason: 'close' }])
  })

  it('review R2: the retry buffer keeps the unfinalized suffix of a partly finalized frame', async () => {
    const dg1 = new FakeAsr()
    const dg2 = new FakeAsr()
    const { t, timers } = turn([dg1, dg2], { limits: { retryBufferMs: 300 } })
    await t.start()
    const a = frame(100, 1)
    t.push(a)
    dg1.result('半', true, { start: 0, duration: 0.05 })
    t.push(frame(100, 2))
    t.push(frame(100, 3))
    t.push(frame(50, 4))
    dg1.close(1011)
    timers.advance(300)
    await flush()
    expect(dg2.audio()[0]).toEqual(a.subarray(1600))
    expect(dg2.audio()).toHaveLength(4)
  })
})
