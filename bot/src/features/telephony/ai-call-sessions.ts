import { aiService } from '../../ai/openrouter.js';
import { transcribeAudio } from '../../ai/multimodal.js';
import { config } from '../../config/index.js';
import { aiLogger } from '../../config/logger.js';
import { settingsRepo } from '../../db/supabase.js';
import type { AIMessage } from '../../../../shared/types/index.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiCallSession,
  TelephonyAiScenario,
} from '../../../../shared/types/telephony.js';

const SESSIONS_KEY = 'lirax_ai_call_sessions';
const SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SESSION_MATCH_WINDOW_MS = 45 * 60 * 1000;
const SESSION_LIMIT = 80;
const RECORDING_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_TOKENS = 900;

interface RegisterTelephonyAiCallSessionParams {
  ownerTelegramId: string;
  initiatedBy: string;
  scenario: TelephonyAiScenario;
  plan: TelephonyAiCallPlan;
  phone: string;
  task: string;
  requestId: string | null;
  requestMode: string;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizePhone(phone: string): string {
  return phone.replace(/[^\d+]/g, '');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  const sliced = value.slice(0, maxLength).trim();
  const lastSpaceIndex = sliced.lastIndexOf(' ');
  return `${sliced.slice(0, Math.max(lastSpaceIndex, 0)).trim()}...`;
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

function pruneSessions(sessions: TelephonyAiCallSession[]): TelephonyAiCallSession[] {
  const now = Date.now();

  return [...sessions]
    .filter((session) => {
      const createdAt = new Date(session.createdAt).getTime();
      return Number.isFinite(createdAt) && now - createdAt < SESSION_RETENTION_MS;
    })
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, SESSION_LIMIT);
}

async function readSessions(): Promise<TelephonyAiCallSession[]> {
  const raw = await settingsRepo.get(SESSIONS_KEY);
  if (!raw) {
    return [];
  }

  const parsed = safeJsonParse<TelephonyAiCallSession[]>(raw);
  return Array.isArray(parsed) ? pruneSessions(parsed) : [];
}

async function writeSessions(sessions: TelephonyAiCallSession[]): Promise<void> {
  await settingsRepo.set(SESSIONS_KEY, JSON.stringify(pruneSessions(sessions)));
}

function updateSession(
  sessions: TelephonyAiCallSession[],
  sessionId: string,
  updater: (session: TelephonyAiCallSession) => TelephonyAiCallSession,
): TelephonyAiCallSession[] {
  return sessions.map((session) => (session.id === sessionId ? updater(session) : session));
}

async function sendTelephonyOwnerMessage(ownerTelegramId: string, text: string): Promise<void> {
  if (!config.telegram.token || !ownerTelegramId) {
    return;
  }

  await fetch(`https://api.telegram.org/bot${config.telegram.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: ownerTelegramId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  }).catch((error) => {
    aiLogger.warn({ error, ownerTelegramId }, '[Telephony AI] Failed to notify owner');
  });
}

async function downloadRecording(recordLink: string): Promise<{ base64: string; mimeType: string } | null> {
  const response = await fetch(recordLink, {
    signal: AbortSignal.timeout(RECORDING_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Не удалось скачать запись (${response.status})`);
  }

  const mimeType = cleanText(response.headers.get('content-type')) || 'audio/mpeg';
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    return null;
  }

  return {
    base64: buffer.toString('base64'),
    mimeType,
  };
}

function buildSummaryPrompt(session: TelephonyAiCallSession, transcript: string): AIMessage[] {
  const systemPrompt = `Ты анализируешь запись исходящего AI-звонка владельца.

Сценарий: ${session.scenarioName}
Цель сценария: ${session.scenarioGoal || 'не указана'}
Критерий успеха: ${session.successCriteria || 'понять итог разговора'}
Подсказка по результату: ${session.resultPrompt || 'сформулируй краткий вывод'}

Ответ СТРОГО в JSON:
{
  "outcomeLabel": "успех | нужен перезвон | отказ | неясно",
  "resultSummary": "краткий вывод для владельца в 1-3 предложениях"
}`;

  const userPrompt = `Задача владельца: ${session.task}
Телефон: ${session.targetPhone}
Расшифровка записи:
${transcript}`;

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
}

async function summarizeRecording(
  session: TelephonyAiCallSession,
  transcript: string,
): Promise<{ outcomeLabel: string; resultSummary: string }> {
  const aiResult = await aiService.chat(
    buildSummaryPrompt(session, transcript),
    'voice',
    undefined,
    {
      promptMode: 'passthrough',
      maxTokens: SUMMARY_MAX_TOKENS,
      temperature: 0.2,
    },
  );

  const jsonPayload = extractJsonObject(aiResult.content);
  const parsed = jsonPayload ? safeJsonParse<Record<string, unknown>>(jsonPayload) : null;

  return {
    outcomeLabel: cleanText(
      typeof parsed?.outcomeLabel === 'string' ? parsed.outcomeLabel : 'неясно',
    ) || 'неясно',
    resultSummary: cleanText(
      typeof parsed?.resultSummary === 'string'
        ? parsed.resultSummary
        : truncateText(transcript, 420),
    ) || truncateText(transcript, 420),
  };
}

export async function registerTelephonyAiCallSession(
  params: RegisterTelephonyAiCallSessionParams,
): Promise<TelephonyAiCallSession> {
  const now = new Date().toISOString();
  const session: TelephonyAiCallSession = {
    id: crypto.randomUUID(),
    ownerTelegramId: params.ownerTelegramId,
    initiatedBy: params.initiatedBy,
    scenarioId: params.scenario.id,
    scenarioName: params.scenario.name,
    scenarioGoal: params.scenario.goal,
    callMode: params.plan.callMode,
    targetPhone: normalizePhone(params.phone),
    task: cleanText(params.task),
    summary: cleanText(params.plan.summary),
    successCriteria: params.scenario.successCriteria,
    resultPrompt: params.scenario.resultPrompt,
    requestId: cleanText(params.requestId),
    requestMode: cleanText(params.requestMode) || 'unknown',
    callId: null,
    recordLink: null,
    transcript: null,
    resultSummary: null,
    outcomeLabel: null,
    status: 'initiated',
    createdAt: now,
    updatedAt: now,
  };

  const sessions = await readSessions();
  await writeSessions([session, ...sessions]);
  return session;
}

export async function getTelephonyAiCallSessions(limit = 20): Promise<TelephonyAiCallSession[]> {
  const sessions = await readSessions();
  return sessions.slice(0, limit);
}

export async function linkTelephonyAiSessionCallId(
  phone: string,
  callId: string,
): Promise<TelephonyAiCallSession | null> {
  const normalizedPhone = normalizePhone(phone);
  const sessions = await readSessions();
  const now = Date.now();

  const session = sessions.find((item) => {
    const createdAt = new Date(item.createdAt).getTime();
    return (
      item.status === 'initiated'
      && !item.callId
      && item.targetPhone === normalizedPhone
      && Number.isFinite(createdAt)
      && now - createdAt < SESSION_MATCH_WINDOW_MS
    );
  });

  if (!session) {
    return null;
  }

  const updatedSession = {
    ...session,
    callId,
    status: 'linked' as const,
    updatedAt: new Date().toISOString(),
  };

  await writeSessions(updateSession(sessions, session.id, () => updatedSession));
  return updatedSession;
}

export async function failTelephonyAiCallByRequestId(
  requestId: string,
): Promise<TelephonyAiCallSession | null> {
  const normalizedRequestId = cleanText(requestId);
  if (!normalizedRequestId) {
    return null;
  }

  const sessions = await readSessions();
  const session = sessions.find((item) => item.requestId === normalizedRequestId);
  if (!session) {
    return null;
  }

  const updatedSession = {
    ...session,
    status: 'failed' as const,
    updatedAt: new Date().toISOString(),
  };

  await writeSessions(updateSession(sessions, session.id, () => updatedSession));
  await sendTelephonyOwnerMessage(
    updatedSession.ownerTelegramId,
    `📵 <b>AI-звонок не состоялся</b>\nСценарий: <b>${escapeHtml(updatedSession.scenarioName)}</b>\nНомер: <code>${escapeHtml(updatedSession.targetPhone)}</code>`,
  );

  return updatedSession;
}

export async function processTelephonyAiCallRecording(
  callId: string,
  recordLink: string,
): Promise<TelephonyAiCallSession | null> {
  const sessions = await readSessions();
  const session = sessions.find((item) => item.callId === callId);
  if (!session || session.status === 'processed') {
    return session ?? null;
  }

  const recordedSession: TelephonyAiCallSession = {
    ...session,
    recordLink,
    status: 'recorded',
    updatedAt: new Date().toISOString(),
  };

  await writeSessions(updateSession(sessions, session.id, () => recordedSession));

  try {
    const audio = await downloadRecording(recordLink);
    if (!audio) {
      throw new Error('Запись пустая');
    }

    const transcription = await transcribeAudio(audio.base64, audio.mimeType);
    const transcript = cleanText(transcription.text);
    const summary = await summarizeRecording(recordedSession, transcript);

    const processedSession: TelephonyAiCallSession = {
      ...recordedSession,
      transcript,
      resultSummary: summary.resultSummary,
      outcomeLabel: summary.outcomeLabel,
      status: 'processed',
      updatedAt: new Date().toISOString(),
    };

    await writeSessions(updateSession(await readSessions(), session.id, () => processedSession));
    await sendTelephonyOwnerMessage(
      processedSession.ownerTelegramId,
      `📞 <b>AI-звонок завершён</b>\n` +
        `Сценарий: <b>${escapeHtml(processedSession.scenarioName)}</b>\n` +
        `Номер: <code>${escapeHtml(processedSession.targetPhone)}</code>\n` +
        `Итог: ${escapeHtml(processedSession.resultSummary || 'Итог не определён')}\n` +
        `Статус: <b>${escapeHtml(processedSession.outcomeLabel || 'неясно')}</b>\n` +
        `🎙 <a href="${recordLink}">Слушать запись</a>\n\n` +
        `Расшифровка:\n<blockquote>${escapeHtml(truncateText(transcript, 1200))}</blockquote>`,
    );

    return processedSession;
  } catch (error) {
    const failedSession: TelephonyAiCallSession = {
      ...recordedSession,
      status: 'failed',
      updatedAt: new Date().toISOString(),
    };

    await writeSessions(updateSession(await readSessions(), session.id, () => failedSession));
    await sendTelephonyOwnerMessage(
      failedSession.ownerTelegramId,
      `⚠️ <b>AI-звонок завершился, но запись не удалось обработать</b>\n` +
        `Сценарий: <b>${escapeHtml(failedSession.scenarioName)}</b>\n` +
        `Номер: <code>${escapeHtml(failedSession.targetPhone)}</code>\n` +
        `🎙 <a href="${recordLink}">Слушать запись</a>`,
    );

    aiLogger.error({ error, callId }, '[Telephony AI] Failed to process call recording');
    return failedSession;
  }
}
