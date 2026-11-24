export type LogFn = (message: string) => void

export const relayLog: LogFn = message => console.log(`[relay] ${message}`)

export function errorName(err: unknown): string {
  if (err && typeof err === 'object' && typeof (err as { name?: unknown }).name === 'string') return (err as { name: string }).name
  return typeof err
}
