export interface Env {
  HUB: DurableObjectNamespace
  SLACK_USER_TOKEN?: string
  SLACK_SIGNING_SECRET?: string
  KID_DM_CHANNEL_ID?: string
  DEEPGRAM_API_KEY?: string
  DEVICE_TOKEN?: string
  FAST_LLM_KEY?: string
  DEEPGRAM_MODEL?: string
  DEEPGRAM_LANGUAGE?: string
  FAST_LANE_ENABLED?: string
}

export interface ConfigStatus {
  slackToken: boolean
  slackSigningSecret: boolean
  kidChannel: boolean
  deepgram: boolean
  deviceToken: boolean
  fastLane: boolean
}

export function configStatus(env: Env): ConfigStatus {
  return {
    slackToken: !!env.SLACK_USER_TOKEN?.startsWith('xoxp-'),
    slackSigningSecret: !!env.SLACK_SIGNING_SECRET,
    kidChannel: /^D[A-Z0-9]{6,}$/.test(env.KID_DM_CHANNEL_ID ?? ''),
    deepgram: !!env.DEEPGRAM_API_KEY,
    deviceToken: (env.DEVICE_TOKEN?.length ?? 0) >= 32,
    fastLane: env.FAST_LANE_ENABLED === 'true' && !!env.FAST_LLM_KEY,
  }
}
