import { FETCH_TIMEOUT_MS } from '../../../config/constants.js';
import { settingsRepo } from '../../../db/supabase.js';
import type { CallRuntime, CallRuntimeContext, CallRuntimeResult } from './runtime-types.js';

interface MediaBridgeConfig {
  enabled: boolean;
  url: string;
  token: string;
}

interface MediaBridgeResponse {
  requestId?: string;
  callId?: string;
  mode?: string;
}

async function getMediaBridgeConfig(): Promise<MediaBridgeConfig> {
  const settings = await settingsRepo.getMany([
    'telephony_realtime_enabled',
    'telephony_media_bridge_url',
    'telephony_media_bridge_token',
  ]);

  return {
    enabled: settings['telephony_realtime_enabled'] === 'true'
      || process.env.TELEPHONY_REALTIME_ENABLED === 'true',
    url: settings['telephony_media_bridge_url'] || process.env.TELEPHONY_MEDIA_BRIDGE_URL || '',
    token: settings['telephony_media_bridge_token'] || process.env.TELEPHONY_MEDIA_BRIDGE_TOKEN || '',
  };
}

async function startMediaBridgeSession(
  context: CallRuntimeContext,
): Promise<CallRuntimeResult> {
  const config = await getMediaBridgeConfig();
  if (!config.enabled || !config.url) {
    throw new Error('Realtime media bridge is not configured');
  }

  const response = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({
      sessionId: context.session.id,
      phone: context.phone,
      task: context.task,
      scenario: context.scenario,
      plan: context.plan,
    }),
  });

  if (!response.ok) {
    throw new Error(`Realtime media bridge error ${response.status}`);
  }

  const payload = await response.json().catch(() => ({})) as MediaBridgeResponse;

  return {
    provider: 'media_bridge',
    requestId: payload.requestId ?? context.session.requestId,
    requestMode: payload.mode ?? 'realtime',
    callId: payload.callId ?? null,
    metadata: {
      runtime: context.scenario.runtimeMode,
      bridgeUrl: config.url,
    },
  };
}

export const realtimeRuntime: CallRuntime = {
  async start(context: CallRuntimeContext): Promise<CallRuntimeResult> {
    return startMediaBridgeSession(context);
  },
};

export async function isRealtimeBridgeAvailable(): Promise<boolean> {
  const config = await getMediaBridgeConfig();
  return Boolean(config.enabled && config.url);
}
