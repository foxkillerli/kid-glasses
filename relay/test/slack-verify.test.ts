import { describe, expect, it } from 'vitest'
import { slackSignature, timingSafeEqual, verifySlackRequest } from '../src/slack-verify'

const secret = '8f742231b10e8888abcd99yyyzzz85a5'
const body = 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&command=%2Fweather'
const ts = '1531420618'

describe('Slack request signing', () => {
  it('matches an HMAC-SHA256 over v0:timestamp:body computed independently with node:crypto', async () => {
    expect(await slackSignature(secret, ts, body)).toBe('v0=6b8b0b4cff7baf56906b6a54056df891b9cc8292bc01770e0e1d6dd9bc623977')
  })

  it('accepts a valid signature within 5 minutes', async () => {
    const signature = await slackSignature(secret, ts, body)
    expect(await verifySlackRequest({ secret, timestamp: ts, signature, body, nowSeconds: 1531420618 + 299 })).toEqual({ ok: true })
  })

  it('rejects stale timestamps, tampered bodies, missing headers and a missing secret', async () => {
    const signature = await slackSignature(secret, ts, body)
    expect(await verifySlackRequest({ secret, timestamp: ts, signature, body, nowSeconds: 1531420618 + 301 })).toEqual({ ok: false, reason: 'stale' })
    expect(await verifySlackRequest({ secret, timestamp: ts, signature, body: body + 'x', nowSeconds: 1531420618 })).toEqual({ ok: false, reason: 'bad-signature' })
    expect(await verifySlackRequest({ secret, timestamp: null, signature, body, nowSeconds: 1531420618 })).toEqual({ ok: false, reason: 'missing-headers' })
    expect(await verifySlackRequest({ secret: '', timestamp: ts, signature, body, nowSeconds: 1531420618 })).toEqual({ ok: false, reason: 'no-secret' })
    expect(await verifySlackRequest({ secret, timestamp: 'abc', signature, body, nowSeconds: 1531420618 })).toEqual({ ok: false, reason: 'stale' })
  })

  it('compares in constant time over the full length', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true)
    expect(timingSafeEqual('abc', 'abd')).toBe(false)
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
  })
})
