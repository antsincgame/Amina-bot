import type {
  TelephonyAiCallPlan,
  TelephonyCallEvent,
  TelephonyCallTurn,
} from '../../../../../shared/types/telephony.js';
import { asRecord, cleanText, truncateText } from '../shared.js';

export interface TelephonyInitialAgentTurn {
  kind: 'speech' | 'greeting' | 'primary_question';
  text: string;
}

export function extractPlanFromEvents(
  events: Array<Pick<TelephonyCallEvent, 'payload'>>,
): TelephonyAiCallPlan | null {
  const payload = events.find((event) => asRecord(event.payload)?.plan)?.payload;
  const record = asRecord(payload);
  const plan = asRecord(record?.plan);
  if (!plan) {
    return null;
  }

  return {
    summary: cleanText(typeof plan.summary === 'string' ? plan.summary : ''),
    callMode: plan.callMode === 'speech' ? 'speech' : 'ask_question',
    speechText: typeof plan.speechText === 'string' ? plan.speechText : null,
    helloText: typeof plan.helloText === 'string' ? plan.helloText : null,
    askText: typeof plan.askText === 'string' ? plan.askText : null,
    okText: typeof plan.okText === 'string' ? plan.okText : null,
    byeText: typeof plan.byeText === 'string' ? plan.byeText : null,
    successHint: typeof plan.successHint === 'string' ? plan.successHint : null,
  };
}

export function buildInitialAgentTurns(plan: TelephonyAiCallPlan | null): TelephonyInitialAgentTurn[] {
  if (!plan) {
    return [];
  }

  if (plan.callMode === 'speech') {
    const speechText = cleanText(plan.speechText);
    return speechText ? [{ kind: 'speech', text: speechText }] : [];
  }

  const turns: TelephonyInitialAgentTurn[] = [];
  const helloText = cleanText(plan.helloText);
  const askText = cleanText(plan.askText);

  if (helloText) {
    turns.push({ kind: 'greeting', text: helloText });
  }

  if (askText) {
    turns.push({ kind: 'primary_question', text: askText });
  }

  return turns;
}

export function buildInitialAgentReplyFromPlan(
  plan: TelephonyAiCallPlan | null,
  fallbackTask?: string | null,
): string {
  const initialTurns = buildInitialAgentTurns(plan);
  if (initialTurns.length > 0) {
    return truncateText(initialTurns.map((turn) => turn.text).join(' '), 320);
  }

  return truncateText(cleanText(fallbackTask), 260);
}

export function buildRealtimeBridgePlan(
  plan: TelephonyAiCallPlan,
  fallbackTask?: string | null,
): TelephonyAiCallPlan {
  if (plan.callMode === 'speech') {
    return plan;
  }

  const initialAgentText = buildInitialAgentReplyFromPlan(plan, fallbackTask);
  if (!initialAgentText) {
    return plan;
  }

  return {
    ...plan,
    helloText: initialAgentText,
    askText: null,
  };
}

export function buildTurnsFromTranscript(
  plan: TelephonyAiCallPlan | null,
  transcript: string,
): Array<Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt'>> {
  const turns: Array<Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt'>> = [];
  let turnIndex = 1;

  for (const turn of buildInitialAgentTurns(plan)) {
    turns.push({
      turnIndex: turnIndex++,
      speaker: 'agent',
      source: 'script',
      content: turn.text,
      confidence: null,
    });
  }

  const cleanTranscript = cleanText(transcript);
  if (cleanTranscript) {
    turns.push({
      turnIndex,
      speaker: 'customer',
      source: 'transcript',
      content: cleanTranscript,
      confidence: null,
    });
  }

  return turns;
}
