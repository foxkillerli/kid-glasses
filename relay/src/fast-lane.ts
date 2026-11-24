import type { Env } from './env'

export interface FastLane {
  readonly enabled: boolean
  answer(question: string): Promise<string | null>
}

export const DISABLED_FAST_LANE: FastLane = {
  enabled: false,
  answer: async () => null,
}

export function fastLaneFor(env: Env): FastLane {
  if (env.FAST_LANE_ENABLED !== 'true' || !env.FAST_LLM_KEY) return DISABLED_FAST_LANE
  return {
    enabled: true,
    answer: async () => null,
  }
}
