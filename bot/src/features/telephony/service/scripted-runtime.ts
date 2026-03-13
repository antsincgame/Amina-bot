import { askQuestion, connectCall } from '../lirax.js';
import { prefixRu } from '../shared.js';
import type { CallRuntime, CallRuntimeContext, CallRuntimeResult } from './runtime-types.js';

export const scriptedRuntime: CallRuntime = {
  async start(context: CallRuntimeContext): Promise<CallRuntimeResult> {
    if (context.plan.callMode === 'speech') {
      const result = await connectCall(context.phone, context.plan.speechText ?? undefined);
      return {
        provider: 'lirax',
        requestId: result.id,
        requestMode: result.mode,
        callId: null,
        metadata: { runtime: 'scripted', callMode: 'speech' },
      };
    }

    const result = await askQuestion({
      to: context.phone,
      hello: prefixRu(context.plan.helloText ?? null),
      ask: prefixRu(context.plan.askText ?? null) ?? 'ru Подскажите, пожалуйста, это вам удобно?',
      ok: prefixRu(context.plan.okText ?? null),
      bye: prefixRu(context.plan.byeText ?? null),
    });

    return {
      provider: 'lirax',
      requestId: result.id,
      requestMode: result.mode,
      callId: null,
      metadata: { runtime: 'scripted', callMode: 'ask_question' },
    };
  },
};
