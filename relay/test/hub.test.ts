import { describe, expect, it, vi } from 'vitest'
import { closeReply } from '../src/hub'

describe('closeReply (hibernation webSocketClose)', () => {
  it('answers a close frame without a status (1005) with a bare close instead of throwing', () => {
    const ws = { close: vi.fn() }
    closeReply(ws, 1005, '')
    expect(ws.close).toHaveBeenCalledWith()
    closeReply(ws, 1006, '')
    expect(ws.close).toHaveBeenLastCalledWith()
  })

  it('echoes a normal close code and swallows errors from an already-closed socket', () => {
    const ws = { close: vi.fn() }
    closeReply(ws, 1000, 'bye')
    expect(ws.close).toHaveBeenCalledWith(1000, 'bye')
    const broken = {
      close: vi.fn(() => {
        throw new Error('InvalidAccessError')
      }),
    }
    expect(() => closeReply(broken, 4001, 'x')).not.toThrow()
  })
})
