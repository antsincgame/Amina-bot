import { aiService } from '../../ai/openrouter.js';
import { aiLogger } from '../../config/logger.js';
import { settingsRepo } from '../../db/supabase.js';
import type { AIMessage } from '../../../../shared/types/index.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiScenario,
} from '../../../../shared/types/telephony.js';
import { registerTelephonyAiCallSession } from './ai-call-sessions.js';
import { askQuestion, connectCall } from './lirax.js';

const SCENARIOS_KEY = 'lirax_ai_scenarios';
const PLAN_MAX_TOKENS = 1200;
const PLAN_TEMPERATURE = 0.25;
const DEFAULT_MAX_SPEECH_CHARS = 420;

interface StartTelephonyAiCallParams {
  scenarioId: string;
  phone: string;
  task: string;
  ownerTelegramId: string;
  initiatedBy: string;
  plan?: TelephonyAiCallPlan;
}

interface TelephonyAiCallResult {
  id: string;
  mode: string;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || `scenario-${Date.now()}`;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const sliced = value.slice(0, maxLength).trim();
  const lastSentenceIndex = Math.max(
    sliced.lastIndexOf('.'),
    sliced.lastIndexOf('!'),
    sliced.lastIndexOf('?'),
  );

  if (lastSentenceIndex >= Math.floor(maxLength * 0.6)) {
    return sliced.slice(0, lastSentenceIndex + 1).trim();
  }

  const lastSpaceIndex = sliced.lastIndexOf(' ');
  return `${sliced.slice(0, Math.max(lastSpaceIndex, 0)).trim()}...`;
}

function prefixRu(text: string | null): string | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = cleanText(text);
  if (!normalized) {
    return undefined;
  }

  return normalized.startsWith('ru ') ? normalized : `ru ${normalized}`;
}

function safeJsonParse<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function extractJsonObject(value: string): string | null {
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  return value.slice(start, end + 1);
}

function normalizeScenario(
  input: Partial<TelephonyAiScenario>,
  index: number,
  now: string,
): TelephonyAiScenario {
  const name = cleanText(input.name) || `Сценарий ${index + 1}`;
  const callMode = input.callMode === 'speech' ? 'speech' : 'ask_question';
  const maxSpeechChars = Number(input.maxSpeechChars);

  return {
    id: cleanText(input.id) || slugify(name),
    name,
    enabled: input.enabled !== false,
    callMode,
    goal: cleanText(input.goal),
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
      goal: 'Коротко напомнить о встрече и получить подтверждение или просьбу связаться позже.',
      systemPrompt:
        'Говори вежливо, спокойно и уверенно. Не импровизируй юридические обещания и не называй несуществующие скидки.',
      openingLine: 'Здравствуйте. Вас беспокоит AI-ассистент Амина.',
      questionHint: 'Сформулируй один чёткий вопрос, на который удобно ответить да/нет или короткой фразой.',
      successCriteria: 'Собеседник подтвердил встречу, согласился на действие или попросил связаться позже.',
      resultPrompt:
        'Кратко выдели: подтвердил ли человек встречу, попросил ли перенос, нужно ли владельцу перезвонить лично.',
    },
    {
      id: 'collect-decision',
      name: 'Сбор решения по предложению',
      enabled: true,
      callMode: 'ask_question',
      goal: 'Озвучить суть предложения и получить финальное решение или удобное время для ответа.',
      systemPrompt:
        'Не дави на человека. Формулируй выгодно, но честно. Уважай отказ и завершай разговор спокойно.',
      openingLine: 'Здравствуйте. Я AI-ассистент Амина, звоню по вашему запросу.',
      questionHint: 'Сконцентрируй вопрос на решении: интересно / неинтересно / когда вернуться с ответом.',
      successCriteria: 'Получен ответ по интересу, согласие на следующий шаг или явный отказ.',
      resultPrompt:
        'Определи, что решил человек: согласен, сомневается, отказался, попросил повторный контакт.',
    },
    {
      id: 'delivery-update',
      name: 'Оперативное уведомление',
      enabled: true,
      callMode: 'speech',
      goal: 'Озвучить важное сообщение по задаче владельца и завершить звонок без длинного диалога.',
      systemPrompt:
        'Сообщение должно звучать как личный помощник владельца. Сразу переходи к сути и говори простыми фразами.',
      openingLine: 'Здравствуйте. Передаю важное голосовое сообщение от Амины.',
      questionHint: '',
      successCriteria: 'Сообщение доставлено без искажений и человеку понятно, что делать дальше.',
      resultPrompt:
        'Если по записи слышно реакцию человека, выдели согласие, вопросы, сомнения или необходимость личного перезвона.',
      maxSpeechChars: 520,
    },
  ];

  return defaults.map((scenario, index) => normalizeScenario(scenario, index, now));
}

export async function getTelephonyOwnerTelegramId(): Promise<string | null> {
  const settings = await settingsRepo.getMany([
    'lirax_owner_chat_id',
    'lirax_admin_chat_id',
    'admin_chat_id',
  ]);

  return (
    cleanText(settings['lirax_owner_chat_id'])
    || cleanText(settings['lirax_admin_chat_id'])
    || cleanText(settings['admin_chat_id'])
    || null
  );
}

export async function isTelephonyOwner(telegramId: string): Promise<boolean> {
  const ownerId = await getTelephonyOwnerTelegramId();
  return !!ownerId && ownerId === telegramId;
}

export async function getTelephonyAiScenarios(): Promise<TelephonyAiScenario[]> {
  const raw = await settingsRepo.get(SCENARIOS_KEY);
  if (!raw) {
    return getDefaultTelephonyAiScenarios();
  }

  const parsed = safeJsonParse<unknown[]>(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return getDefaultTelephonyAiScenarios();
  }

  const now = new Date().toISOString();
  return parsed.map((item, index) => normalizeScenario((item ?? {}) as Partial<TelephonyAiScenario>, index, now));
}

export async function saveTelephonyAiScenarios(
  scenarios: TelephonyAiScenario[],
): Promise<TelephonyAiScenario[]> {
  const now = new Date().toISOString();
  const normalized = scenarios.map((scenario, index) => normalizeScenario(scenario, index, now));
  await settingsRepo.set(SCENARIOS_KEY, JSON.stringify(normalized));
  return normalized;
}

async function resolveScenarioById(scenarioId: string): Promise<TelephonyAiScenario> {
  const scenarios = await getTelephonyAiScenarios();
  const scenario = scenarios.find((item) => item.id === scenarioId);

  if (!scenario || !scenario.enabled) {
    throw new Error('Сценарий не найден или выключен');
  }

  return scenario;
}

function buildPlanPrompt(scenario: TelephonyAiScenario, task: string, phone: string): AIMessage[] {
  const responseShape =
    scenario.callMode === 'speech'
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

  const systemPrompt = `Ты проектируешь исходящий AI-звонок для LiraX.

Режим сценария: ${scenario.callMode === 'speech' ? 'speech-only' : 'ask-question'}.
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
- Ответ СТРОГО в JSON без пояснений.

Формат ответа:
${responseShape}`;

  const userPrompt = `Телефон абонента: ${phone}
Задача владельца: ${task}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

function buildFallbackPlan(scenario: TelephonyAiScenario, task: string): TelephonyAiCallPlan {
  const summary = truncateText(task, 160);
  const successHint = scenario.successCriteria || 'Нужно понять, состоялся ли полезный контакт.';

  if (scenario.callMode === 'speech') {
    const speechText = truncateText(
      cleanText(`${scenario.openingLine} ${task}`),
      scenario.maxSpeechChars,
    );

    return {
      summary,
      callMode: 'speech',
      speechText,
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

function normalizePlan(
  scenario: TelephonyAiScenario,
  rawPlan: Record<string, unknown> | null,
  task: string,
): TelephonyAiCallPlan {
  const fallback = buildFallbackPlan(scenario, task);
  if (!rawPlan) {
    return fallback;
  }

  const summary = cleanText(typeof rawPlan.summary === 'string' ? rawPlan.summary : fallback.summary) || fallback.summary;
  const successHint = cleanText(
    typeof rawPlan.successHint === 'string' ? rawPlan.successHint : fallback.successHint,
  ) || fallback.successHint;

  if (scenario.callMode === 'speech') {
    const speechText = cleanText(
      typeof rawPlan.speechText === 'string' ? rawPlan.speechText : fallback.speechText,
    );

    return {
      ...fallback,
      summary,
      successHint,
      speechText: truncateText(speechText || fallback.speechText || '', scenario.maxSpeechChars),
    };
  }

  return {
    ...fallback,
    summary,
    successHint,
    helloText: truncateText(
      cleanText(typeof rawPlan.helloText === 'string' ? rawPlan.helloText : fallback.helloText),
      160,
    ),
    askText: truncateText(
      cleanText(typeof rawPlan.askText === 'string' ? rawPlan.askText : fallback.askText),
      260,
    ),
    okText: truncateText(
      cleanText(typeof rawPlan.okText === 'string' ? rawPlan.okText : fallback.okText),
      180,
    ),
    byeText: truncateText(
      cleanText(typeof rawPlan.byeText === 'string' ? rawPlan.byeText : fallback.byeText),
      160,
    ),
  };
}

function toPlanInput(plan: TelephonyAiCallPlan): Record<string, unknown> {
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

export async function previewTelephonyAiCall(
  scenarioId: string,
  task: string,
  phone: string,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan }> {
  const scenario = await resolveScenarioById(scenarioId);
  const aiResult = await aiService.chat(
    buildPlanPrompt(scenario, task, phone),
    'voice',
    undefined,
    {
      promptMode: 'passthrough',
      maxTokens: PLAN_MAX_TOKENS,
      temperature: PLAN_TEMPERATURE,
    },
  );

  const jsonPayload = extractJsonObject(aiResult.content);
  const rawPlan = jsonPayload ? safeJsonParse<Record<string, unknown>>(jsonPayload) : null;
  const plan = normalizePlan(scenario, rawPlan, task);

  aiLogger.info({ scenarioId, phone, model: aiResult.model }, '[Telephony AI] Call plan generated');

  return { scenario, plan };
}

export async function startTelephonyAiCall(
  params: StartTelephonyAiCallParams,
): Promise<{ scenario: TelephonyAiScenario; plan: TelephonyAiCallPlan; result: TelephonyAiCallResult }> {
  const scenario = await resolveScenarioById(params.scenarioId);
  const plan = params.plan
    ? normalizePlan(scenario, toPlanInput(params.plan), params.task)
    : (await previewTelephonyAiCall(params.scenarioId, params.task, params.phone)).plan;

  let result: TelephonyAiCallResult;
  if (plan.callMode === 'speech') {
    const callResult = await connectCall(params.phone, plan.speechText ?? undefined);
    result = { id: callResult.id, mode: callResult.mode };
  } else {
    const askResult = await askQuestion({
      to: params.phone,
      hello: prefixRu(plan.helloText ?? null),
      ask: prefixRu(plan.askText ?? null) ?? 'ru Подскажите, пожалуйста, это вам удобно?',
      ok: prefixRu(plan.okText ?? null),
      bye: prefixRu(plan.byeText ?? null),
    });
    result = { id: askResult.id, mode: askResult.mode };
  }

  await registerTelephonyAiCallSession({
    ownerTelegramId: params.ownerTelegramId,
    initiatedBy: params.initiatedBy,
    scenario,
    plan,
    phone: params.phone,
    task: params.task,
    requestId: result.id,
    requestMode: result.mode,
  });

  return { scenario, plan, result };
}
