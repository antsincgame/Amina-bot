import type { TelephonyRuntimeMode } from '../../../../../shared/types/telephony.js';
import { scriptedRuntime } from './scripted-runtime.js';
import { isRealtimeBridgeAvailable, realtimeRuntime } from './realtime-runtime.js';
import type { CallRuntimeContext, CallRuntimeResult } from './runtime-types.js';

function withRuntimeMetadata(
  result: CallRuntimeResult,
  selectedRuntime: TelephonyRuntimeMode,
  executedRuntime: TelephonyRuntimeMode,
  fallbackReason?: string,
): CallRuntimeResult {
  return {
    ...result,
    metadata: {
      ...result.metadata,
      selectedRuntime,
      executedRuntime,
      fallbackReason: fallbackReason ?? null,
    },
  };
}

export async function startThroughRuntimeRouter(
  context: CallRuntimeContext,
): Promise<CallRuntimeResult> {
  const selectedRuntime = context.scenario.runtimeMode;

  if (selectedRuntime === 'scripted' || selectedRuntime === 'shadow') {
    const result = await scriptedRuntime.start(context);
    return withRuntimeMetadata(result, selectedRuntime, 'scripted');
  }

  const bridgeAvailable = await isRealtimeBridgeAvailable();
  if (!bridgeAvailable) {
    if (context.scenario.policy.fallbackMode !== 'scripted') {
      throw new Error('Realtime runtime requested, but media bridge is unavailable');
    }

    const result = await scriptedRuntime.start(context);
    return withRuntimeMetadata(
      result,
      selectedRuntime,
      'scripted',
      'realtime bridge unavailable',
    );
  }

  const result = await realtimeRuntime.start(context);
  return withRuntimeMetadata(result, selectedRuntime, selectedRuntime);
}
