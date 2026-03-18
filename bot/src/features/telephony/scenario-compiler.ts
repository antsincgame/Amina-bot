import type { AIMessage } from '../../../../shared/types/index.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiScenario,
  TelephonyAiScenarioPolicy,
  TelephonyFallbackMode,
  TelephonyRuntimeMode,
} from '../../../../shared/types/telephony.js';
import {
  DEFAULT_POLICY_VERSION,
  DEFAULT_RUNTIME_MODE,
  asRecord,
  cleanText,
  createDefaultScenarioPolicy,
  slugify,
  truncateText,
} from './shared.js';
import { buildPersonaSystemPrompt } from '../../ai/persona.js';

const DEFAULT_MAX_SPEECH_CHARS = 420;

function normalizeFallbackMode(value: string | null | undefined): TelephonyFallbackMode {
  return value === 'fail' ? 'fail' : 'scripted';
}

function normalizeRuntimeMode(value: string | null | undefined): TelephonyRuntimeMode {
  if (value === 'hybrid' || value === 'realtime') {
    return value;
  }

  if (value === 'shadow') {
    return 'scripted';
  }

  return DEFAULT_RUNTIME_MODE;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => cleanText(typeof item === 'string' ? item : '')).filter(Boolean)
    : [];
}

export function normalizeScenarioPolicy(
  input: unknown,
  goal: string,
): TelephonyAiScenarioPolicy {
  const fallback = createDefaultScenarioPolicy(goal);
  const record = asRecord(input);

  if (!record) {
    return fallback;
  }

  const maxSilenceMs = Number(record.maxSilenceMs);
  const maxTurns = Number(record.maxTurns);

  return {
    allowedClaims: normalizeStringArray(record.allowedClaims).length > 0
      ? normalizeStringArray(record.allowedClaims)
      : fallback.allowedClaims,
    requiredSlots: normalizeStringArray(record.requiredSlots),
    exitConditions: normalizeStringArray(record.exitConditions).length > 0
      ? normalizeStringArray(record.exitConditions)
      : fallback.exitConditions,
    handoffRules: normalizeStringArray(record.handoffRules).length > 0
      ? normalizeStringArray(record.handoffRules)
      : fallback.handoffRules,
    maxSilenceMs: Number.isFinite(maxSilenceMs) && maxSilenceMs >= 1000 && maxSilenceMs <= 30000
      ? maxSilenceMs
      : fallback.maxSilenceMs,
    maxTurns: Number.isFinite(maxTurns) && maxTurns >= 1 && maxTurns <= 30
      ? maxTurns
      : fallback.maxTurns,
    fallbackMode: normalizeFallbackMode(
      typeof record.fallbackMode === 'string' ? record.fallbackMode : null,
    ),
  };
}

export function normalizeScenario(
  input: Partial<TelephonyAiScenario>,
  index: number,
  now: string,
): TelephonyAiScenario {
  const name = cleanText(input.name) || `Сценарий ${index + 1}`;
  const goal = cleanText(input.goal);
  const maxSpeechChars = Number(input.maxSpeechChars);

  return {
    id: cleanText(input.id) || slugify(name),
    name,
    enabled: input.enabled !== false,
    callMode: input.callMode === 'speech' ? 'speech' : 'ask_question',
    runtimeMode: normalizeRuntimeMode(input.runtimeMode),
    policyVersion:
      Number.isFinite(Number(input.policyVersion)) && Number(input.policyVersion) >= 1
        ? Number(input.policyVersion)
        : DEFAULT_POLICY_VERSION,
    policy: normalizeScenarioPolicy(input.policy, goal),
    goal,
    systemPrompt: cleanText(input.systemPrompt),
    openingLine: cleanText(input.openingLine),
    questionHint: cleanText(input.questionHint),
    successCriteria: cleanText(input.successCriteria),
    resultPrompt: cleanText(input.resultPrompt),
    maxSpeechChars:
      Number.isFinite(maxSpeechChars) && maxSpeechChars >= 140 && maxSpeechChars <= 900
        ? maxSpeechChars
        : DEFAULT_MAX_SPEECH_CHARS,
    createdAt: cleanText(input.createdAt) || now,
    updatedAt: now,
  };
}

export function getDefaultTelephonyAiScenarios(): TelephonyAiScenario[] {
  const now = new Date().toISOString();

  const defaults: Array<Partial<TelephonyAiScenario>> = [
    {
      id: 'confirm-meeting',
      name: 'Подтверждение встречи',
      enabled: true,
      callMode: 'ask_question',
      runtimeMode: 'hybrid',
      goal: 'Коротко напомнить о встрече и получить подтверждение или просьбу связаться позже.',
      systemPrompt:
        'Говори вежливо, спокойно и уверенно. Не импровизируй юридические обещания и не называй несуществующие скидки.',
      openingLine: 'Здравствуйте. Вас беспокоит Амина, жена Дмитрия Орлова — звоню по его поручению.',
      questionHint: 'Сформулируй один чёткий вопрос, на который удобно ответить да или нет.',
      successCriteria: 'Собеседник подтвердил встречу, согласился на действие или попросил связаться позже.',
      resultPrompt:
        'Кратко выдели: подтвердил ли человек встречу, попросил ли перенос, нужно ли владельцу перезвонить лично.',
    },
    {
      id: 'collect-decision',
      name: 'Сбор решения по предложению',
      enabled: true,
      callMode: 'ask_question',
      runtimeMode: 'scripted',
      goal: 'Озвучить суть предложения и получить финальное решение или удобное время для ответа.',
      systemPrompt:
        'Не дави на человека. Формулируй выгодно, но честно. Уважай отказ и завершай разговор спокойно.',
      openingLine: 'Здравствуйте. Это Амина, звоню от Дмитрия Орлова — сразу перейду к сути.',
      questionHint: 'Сконцентрируй вопрос на решении: интересно, неинтересно или когда вернуться с ответом.',
      successCriteria: 'Получен ответ по интересу, согласие на следующий шаг или явный отказ.',
      resultPrompt:
        'Определи, что решил человек: согласен, сомневается, отказался, попросил повторный контакт.',
    },
    {
      id: 'delivery-update',
      name: 'Оперативное уведомление',
      enabled: true,
      callMode: 'speech',
      runtimeMode: 'scripted',
      goal: 'Озвучить важное сообщение по задаче владельца и завершить звонок без длинного диалога.',
      systemPrompt:
        'Сообщение должно звучать как личный помощник владельца. Сразу переходи к сути и говори простыми фразами.',
      openingLine: 'Здравствуйте. Амина, жена Дмитрия Орлова — передаю вам важное сообщение от него.',
      successCriteria: 'Сообщение доставлено без искажений и человеку понятно, что делать дальше.',
      resultPrompt:
        'Если по записи слышно реакцию человека, выдели согласие, вопросы, сомнения или необходимость личного перезвона.',
      maxSpeechChars: 520,
    },
    {
      id: 'freeform',
      name: 'Свободный диалог',
      enabled: true,
      callMode: 'ask_question',
      runtimeMode: 'realtime',
      goal: 'AI ведёт свободный разговор с собеседником без жёсткого сценария, адаптируясь к теме и контексту задачи владельца.',
      systemPrompt:
        'Ты ведёшь свободный телефонный разговор. Говори естественно, кратко, по делу. Слушай собеседника, задавай уточняющие вопросы. Не навязывай структуру, следуй за ходом беседы. Завершай, когда цель достигнута или собеседник прощается.',
      openingLine: 'Здравствуйте. Меня зовут Амина — звоню от Дмитрия Орлова.',
      questionHint: 'Не ограничивайся одним вопросом — веди живой диалог, задавай уточнения по ходу разговора.',
      successCriteria: 'Разговор прошёл продуктивно: получена нужная информация или достигнута цель задачи владельца.',
      resultPrompt:
        'Выдели ключевые договорённости, решения, вопросы собеседника и общий тон разговора.',
      policy: {
        maxTurns: 20,
        maxSilenceMs: 8000,
        fallbackMode: 'scripted' as const,
        allowedClaims: [],
        requiredSlots: [],
        exitConditions: [],
        handoffRules: [],
      },
    },
  ];

  return defaults.map((scenario, index) => normalizeScenario(scenario, index, now));
}

export async function buildPlanPrompt(
  scenario: TelephonyAiScenario,
  task: string,
  phone: string,
): Promise<AIMessage[]> {
  const responseShape = scenario.callMode === 'speech'
    ? `{
  "summary": "кратко что делаем",
  "speechText": "готовый текст для озвучки абоненту",
  "successHint": "что считать успешным итогом"
}`
    : `{
  "summary": "кратко что делаем",
  "helloText": "приветствие",
  "askText": "один основной вопрос",
  "okText": "фраза если собеседник согласен",
  "byeText": "короткое завершение звонка",
  "successHint": "что считать успешным итогом"
}`;

  const personaPrompt = await buildPersonaSystemPrompt({
    channel: 'voice',
    extraRules: [
      'Режим задачи: проектирование исходящего телефонного сценария.',
      'Тебе нужно собрать план звонка, а не вести сам разговор.',
      'Ответ должен быть строго в JSON без пояснений.',
    ],
  });

  return [
    {
      role: 'system',
      content: `${personaPrompt}

Ты проектируешь исходящий AI-звонок для LiraX.

Режим сценария: ${scenario.callMode === 'speech' ? 'speech-only' : 'ask-question'}.
Runtime режима: ${scenario.runtimeMode}.
Цель сценария: ${scenario.goal || 'не указана'}.
Контекст владельца: ${scenario.systemPrompt || 'нет дополнительного контекста'}.
Открывающая линия: ${scenario.openingLine || 'сформулируй сам'}.
Подсказка по вопросу: ${scenario.questionHint || 'нет'}.
Критерий успеха: ${scenario.successCriteria || 'получить понятный итог разговора'}.

Ограничения:
- Пиши только по-русски.
- Фразы должны звучать естественно в телефонном разговоре.
- Не используй Markdown, эмодзи и списки.
- Не делай длинные монологи.
- Для режима ask_question задай только один главный вопрос.
- Для режима speech уложи основной текст в ${scenario.maxSpeechChars} символов.
- Ответ строго в JSON без пояснений.

Формат ответа:
${responseShape}`,
    },
    {
      role: 'user',
      content: `Телефон абонента: ${phone}\nЗадача владельца: ${task}`,
    },
  ];
}

export function buildFallbackPlan(
  scenario: TelephonyAiScenario,
  task: string,
): TelephonyAiCallPlan {
  const summary = truncateText(task, 160);
  const successHint = scenario.successCriteria || 'Нужно понять, состоялся ли полезный контакт.';

  if (scenario.callMode === 'speech') {
    return {
      summary,
      callMode: 'speech',
      speechText: truncateText(cleanText(`${scenario.openingLine} ${task}`), scenario.maxSpeechChars),
      helloText: null,
      askText: null,
      okText: null,
      byeText: null,
      successHint,
    };
  }

  return {
    summary,
    callMode: 'ask_question',
    speechText: null,
    helloText: truncateText(scenario.openingLine || 'Здравствуйте. Звоню от имени Амины.', 140),
    askText: truncateText(task, 220),
    okText: 'Спасибо, я передам владельцу, что вы согласны.',
    byeText: 'Благодарю за ответ. До свидания.',
    successHint,
  };
}

export function normalizePlan(
  scenario: TelephonyAiScenario,
  rawPlan: Record<string, unknown> | null,
  task: string,
): TelephonyAiCallPlan {
  const fallback = buildFallbackPlan(scenario, task);
  if (!rawPlan) {
    return fallback;
  }

  if (scenario.callMode === 'speech') {
    return {
      ...fallback,
      summary: cleanText(typeof rawPlan.summary === 'string' ? rawPlan.summary : fallback.summary) || fallback.summary,
      speechText: truncateText(
        cleanText(typeof rawPlan.speechText === 'string' ? rawPlan.speechText : fallback.speechText),
        scenario.maxSpeechChars,
      ),
      successHint: cleanText(typeof rawPlan.successHint === 'string' ? rawPlan.successHint : fallback.successHint) || fallback.successHint,
    };
  }

  return {
    ...fallback,
    summary: cleanText(typeof rawPlan.summary === 'string' ? rawPlan.summary : fallback.summary) || fallback.summary,
    helloText: truncateText(cleanText(typeof rawPlan.helloText === 'string' ? rawPlan.helloText : fallback.helloText), 160),
    askText: truncateText(cleanText(typeof rawPlan.askText === 'string' ? rawPlan.askText : fallback.askText), 260),
    okText: truncateText(cleanText(typeof rawPlan.okText === 'string' ? rawPlan.okText : fallback.okText), 180),
    byeText: truncateText(cleanText(typeof rawPlan.byeText === 'string' ? rawPlan.byeText : fallback.byeText), 160),
    successHint: cleanText(typeof rawPlan.successHint === 'string' ? rawPlan.successHint : fallback.successHint) || fallback.successHint,
  };
}

export function toPlanInput(plan: TelephonyAiCallPlan): Record<string, unknown> {
  return {
    summary: plan.summary,
    speechText: plan.speechText,
    helloText: plan.helloText,
    askText: plan.askText,
    okText: plan.okText,
    byeText: plan.byeText,
    successHint: plan.successHint,
  };
}
