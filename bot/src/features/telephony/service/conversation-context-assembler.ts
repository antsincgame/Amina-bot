import type { AIMessage } from '../../../../../shared/types/index.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiCallSession,
  TelephonyAiScenario,
  TelephonyCallTurn,
} from '../../../../../shared/types/telephony.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { scenarioRepo } from '../repository/scenario-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { callTurnRepo } from '../repository/call-turn-repo.js';
import { cleanText, truncateText } from '../shared.js';
import { extractPlanFromEvents } from './telephony-plan.js';

export interface ConversationAssemblyResult {
  session: TelephonyAiCallSession;
  scenario: TelephonyAiScenario;
  plan: TelephonyAiCallPlan | null;
  turns: TelephonyCallTurn[];
  messages: AIMessage[];
}

function stringifyRules(lines: string[]): string {
  return lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : '- нет';
}

function formatTurnsForPrompt(turns: TelephonyCallTurn[]): string {
  if (turns.length === 0) {
    return 'История разговора пока пуста.';
  }

  return turns
    .map((turn) => `${turn.turnIndex}. ${turn.speaker === 'agent' ? 'Агент' : turn.speaker === 'customer' ? 'Собеседник' : 'Система'}: ${truncateText(turn.content, 240)}`)
    .join('\n');
}

function formatPlanForPrompt(plan: TelephonyAiCallPlan | null): string {
  if (!plan) {
    return 'План звонка не сохранён, опирайся на задачу владельца и историю разговора.';
  }

  return [
    `summary: ${plan.summary || 'не указано'}`,
    `callMode: ${plan.callMode}`,
    `speechText: ${plan.speechText || '—'}`,
    `helloText: ${plan.helloText || '—'}`,
    `askText: ${plan.askText || '—'}`,
    `okText: ${plan.okText || '—'}`,
    `byeText: ${plan.byeText || '—'}`,
    `successHint: ${plan.successHint || '—'}`,
  ].join('\n');
}

export async function assembleConversationContext(
  sessionId: string,
  incomingCustomerText: string,
): Promise<ConversationAssemblyResult> {
  const session = await callSessionRepo.getById(sessionId);
  if (!session) {
    throw new Error('Сессия realtime-звонка не найдена');
  }

  const [scenario, turns, events] = await Promise.all([
    scenarioRepo.getById(session.scenarioId),
    callTurnRepo.listBySession(sessionId),
    callEventRepo.listBySession(sessionId),
  ]);
  if (!scenario) {
    throw new Error('Сценарий realtime-звонка не найден');
  }

  const plan = extractPlanFromEvents(events);
  const cleanIncomingText = cleanText(incomingCustomerText);

  const isFreeform = scenario.id === 'freeform';

  const freeformInstructions = isFreeform
    ? `\nЭто СВОБОДНЫЙ ДИАЛОГ. Не следуй жёсткому сценарию.
Веди естественный телефонный разговор: слушай, задавай уточняющие вопросы, реагируй на ответы.
Адаптируй тему и стиль под ход беседы, но держи в фокусе задачу владельца.
Если собеседник прощается или тема исчерпана — завершай звонок.`
    : '';

  const systemPrompt = `Ты управляешь realtime AI-звонком владельца.
Это ТЕЛЕФОННЫЙ разговор: будь кратким, естественным, разговорным. Не пиши длинных монологов.

Сценарий: ${scenario.name}
Цель сценария: ${scenario.goal || 'не указана'}
Контекст владельца: ${scenario.systemPrompt || 'не указан'}
Открывающая линия сценария: ${scenario.openingLine || 'не указана'}
Подсказка по вопросу: ${scenario.questionHint || 'не указана'}
Task brief владельца: ${session.task}
Критерий успеха: ${session.successCriteria || 'получить полезный итог разговора'}
Подсказка по summary: ${session.resultPrompt || 'сформулируй чёткий итог'}
Скомпилированный план звонка:
${formatPlanForPrompt(plan)}
Ограничения сценария:
- Максимум ходов агента: ${scenario.policy.maxTurns}
- Максимальная пауза: ${scenario.policy.maxSilenceMs} мс
- allowedClaims:
${stringifyRules(scenario.policy.allowedClaims)}
- requiredSlots:
${stringifyRules(scenario.policy.requiredSlots)}
- exitConditions:
${stringifyRules(scenario.policy.exitConditions)}
- handoffRules:
${stringifyRules(scenario.policy.handoffRules)}
${freeformInstructions}
Говори по-русски, короткими телефонными фразами.
Не обещай того, чего нет в контексте.
Не используй Markdown, эмодзи и списки в ответе для абонента.
Если уже достаточно данных для завершения звонка, пометь shouldEndCall=true.
Если нужно срочно уйти в fallback, пометь shouldFallback=true и укажи причину.

Ответ строго в JSON:
{
  "replyText": "что сказать абоненту",
  "shouldEndCall": false,
  "shouldFallback": false,
  "fallbackReason": null,
  "outcomeLabel": "успех | нужен перезвон | отказ | неясно",
  "resultSummary": "краткий итог для владельца"
}`;

  const messages: AIMessage[] = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content:
        `История разговора:\n${formatTurnsForPrompt(turns)}\n\n` +
        `Новая реплика собеседника:\n${cleanIncomingText || '[пусто]'}`,
    },
  ];

  return {
    session,
    scenario,
    plan,
    turns,
    messages,
  };
}
