import { aiService } from '../../../ai/openrouter.js';
import { transcribeAudio } from '../../../ai/multimodal.js';
import { aiLogger } from '../../../config/logger.js';
import { analyticsRepo } from '../../../db/supabase.js';
import type { AIMessage } from '../../../../../shared/types/index.js';
import type {
  TelephonyAiCallPlan,
  TelephonyAiCallSession,
  TelephonyCallTurn,
} from '../../../../../shared/types/telephony.js';
import { callArtifactRepo } from '../repository/call-artifact-repo.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callOutcomeRepo } from '../repository/call-outcome-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { callTurnRepo } from '../repository/call-turn-repo.js';
import { asRecord, cleanText, escapeHtml as _escapeHtml, extractJsonObject, safeJsonParse, truncateText } from '../shared.js';
import { sendTelephonyOwnerMessage } from './notification-service.js';

const RECORDING_TIMEOUT_MS = 30_000;
const SUMMARY_MAX_TOKENS = 900;

function escapeHtml(value: string): string {
  return _escapeHtml
    ? _escapeHtml(value)
    : value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

  return { base64: buffer.toString('base64'), mimeType };
}

function buildSummaryPrompt(session: TelephonyAiCallSession, transcript: string): AIMessage[] {
  return [
    {
      role: 'system',
      content: `Ты анализируешь запись исходящего AI-звонка владельца.

Сценарий: ${session.scenarioName}
Цель сценария: ${session.scenarioGoal || 'не указана'}
Критерий успеха: ${session.successCriteria || 'понять итог разговора'}
Подсказка по результату: ${session.resultPrompt || 'сформулируй краткий вывод'}

Ответ строго в JSON:
{
  "outcomeLabel": "успех | нужен перезвон | отказ | неясно",
  "resultSummary": "краткий вывод для владельца в 1-3 предложениях"
}`,
    },
    {
      role: 'user',
      content: `Задача владельца: ${session.task}
Телефон: ${session.targetPhone}
Расшифровка записи:
${transcript}`,
    },
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

  const parsed = safeJsonParse<Record<string, unknown>>(extractJsonObject(aiResult.content) ?? '');
  return {
    outcomeLabel: cleanText(typeof parsed?.outcomeLabel === 'string' ? parsed.outcomeLabel : 'неясно') || 'неясно',
    resultSummary: cleanText(
      typeof parsed?.resultSummary === 'string' ? parsed.resultSummary : truncateText(transcript, 420),
    ) || truncateText(transcript, 420),
  };
}

function extractPlanFromEvents(events: Array<{ payload: Record<string, unknown> }>): TelephonyAiCallPlan | null {
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

function buildTurns(plan: TelephonyAiCallPlan | null, transcript: string): Array<Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt'>> {
  const turns: Array<Omit<TelephonyCallTurn, 'id' | 'sessionId' | 'createdAt'>> = [];
  let turnIndex = 1;

  if (plan?.callMode === 'speech' && plan.speechText) {
    turns.push({
      turnIndex: turnIndex++,
      speaker: 'agent',
      source: 'script',
      content: plan.speechText,
      confidence: null,
    });
  }

  if (plan?.callMode === 'ask_question') {
    for (const content of [plan.helloText, plan.askText]) {
      const text = cleanText(content);
      if (text) {
        turns.push({
          turnIndex: turnIndex++,
          speaker: 'agent',
          source: 'script',
          content: text,
          confidence: null,
        });
      }
    }
  }

  const cleanTranscript = cleanText(transcript);
  if (cleanTranscript) {
    turns.push({
      turnIndex: turnIndex,
      speaker: 'customer',
      source: 'transcript',
      content: cleanTranscript,
      confidence: null,
    });
  }

  return turns;
}

export async function processRecordingForSession(
  sessionId: string,
  recordLink: string,
): Promise<TelephonyAiCallSession> {
  const session = await callSessionRepo.getById(sessionId);
  if (!session) {
    throw new Error('Сессия звонка не найдена для обработки записи');
  }

  if (session.status === 'processed') {
    return session;
  }

  const recordedSession = await callSessionRepo.update(session.id, {
    recordLink,
    status: 'recorded',
  });

  await callArtifactRepo.upsertForSession(session.id, 'recording', {
    status: 'ready',
    url: recordLink,
    content: null,
    metadata: {},
  });

  try {
    const audio = await downloadRecording(recordLink);
    if (!audio) {
      throw new Error('Запись пустая');
    }

    const transcription = await transcribeAudio(audio.base64, audio.mimeType);
    const transcript = cleanText(transcription.text);
    await callArtifactRepo.upsertForSession(session.id, 'transcript', {
      status: 'ready',
      url: null,
      content: transcript,
      metadata: { mimeType: audio.mimeType },
    });

    const plan = extractPlanFromEvents(await callEventRepo.listBySession(session.id));
    await callTurnRepo.replaceForSession(session.id, buildTurns(plan, transcript));

    const summary = await summarizeRecording(recordedSession, transcript);
    await callArtifactRepo.upsertForSession(session.id, 'summary', {
      status: 'ready',
      url: null,
      content: summary.resultSummary,
      metadata: { outcomeLabel: summary.outcomeLabel },
    });

    await callOutcomeRepo.saveForSession(session.id, {
      outcomeLabel: summary.outcomeLabel,
      resultSummary: summary.resultSummary,
      confidence: null,
      metadata: {},
    });

    const processedSession = await callSessionRepo.update(session.id, {
      transcript,
      resultSummary: summary.resultSummary,
      outcomeLabel: summary.outcomeLabel,
      status: 'processed',
    });

    await callEventRepo.record(session.id, 'record_processed', { recordLink, outcomeLabel: summary.outcomeLabel });
    analyticsRepo.log('call_ended', 'voice', {
      sessionId: session.id,
      scenarioId: session.scenarioId,
      runtimeMode: session.runtimeMode,
      outcomeLabel: summary.outcomeLabel,
    }).catch(() => {});

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
    await callArtifactRepo.upsertForSession(session.id, 'analysis_report', {
      status: 'failed',
      url: recordLink,
      content: error instanceof Error ? error.message : String(error),
      metadata: {},
    });

    const failedSession = await callSessionRepo.update(session.id, { status: 'failed' });
    await callEventRepo.record(session.id, 'record_processing_failed', {
      recordLink,
      error: error instanceof Error ? error.message : String(error),
    });
    aiLogger.error({ error, sessionId }, '[Telephony] Failed to process recording');

    await sendTelephonyOwnerMessage(
      failedSession.ownerTelegramId,
      `⚠️ <b>AI-звонок завершился, но запись не удалось обработать</b>\n` +
        `Сценарий: <b>${escapeHtml(failedSession.scenarioName)}</b>\n` +
        `Номер: <code>${escapeHtml(failedSession.targetPhone)}</code>\n` +
        `🎙 <a href="${recordLink}">Слушать запись</a>`,
    );

    throw error;
  }
}
