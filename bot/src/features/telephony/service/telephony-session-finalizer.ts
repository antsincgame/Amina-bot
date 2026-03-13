import { aiService } from '../../../ai/openrouter.js';
import type { AIMessage } from '../../../../../shared/types/index.js';
import type { TelephonyAiCallSession, TelephonyAiSessionStatus } from '../../../../../shared/types/telephony.js';
import { callArtifactRepo } from '../repository/call-artifact-repo.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callOutcomeRepo } from '../repository/call-outcome-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { callTurnRepo } from '../repository/call-turn-repo.js';
import { cleanText, escapeHtml, extractJsonObject, safeJsonParse, truncateText } from '../shared.js';
import { sendTelephonyOwnerMessage } from './notification-service.js';
import { buildTurnsFromTranscript, extractPlanFromEvents } from './telephony-plan.js';

const SUMMARY_MAX_TOKENS = 900;

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

export async function summarizeTelephonyTranscript(
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

export async function finalizeTelephonyTranscript(
  sessionId: string,
  transcriptInput: string,
  options?: {
    recordLink?: string | null;
    finalStatus?: TelephonyAiSessionStatus;
    transcriptMetadata?: Record<string, unknown>;
  },
): Promise<TelephonyAiCallSession> {
  const session = await callSessionRepo.getById(sessionId);
  if (!session) {
    throw new Error('Сессия звонка не найдена для финализации transcript');
  }

  const transcript = cleanText(transcriptInput);
  if (session.status === 'processed' && cleanText(session.transcript) === transcript) {
    return session;
  }

  const plan = extractPlanFromEvents(await callEventRepo.listBySession(session.id));

  await callArtifactRepo.upsertForSession(session.id, 'transcript_final', {
    status: 'ready',
    url: null,
    storagePath: null,
    content: transcript,
    mimeType: 'text/plain',
    sizeBytes: transcript.length,
    durationMs: null,
    checksumSha256: null,
    archiveStatus: null,
    retentionUntil: null,
    version: 1,
    metadata: options?.transcriptMetadata ?? {},
  });

  await callArtifactRepo.upsertForSession(session.id, 'transcript', {
    status: 'ready',
    url: null,
    storagePath: null,
    content: transcript,
    mimeType: 'text/plain',
    sizeBytes: transcript.length,
    durationMs: null,
    checksumSha256: null,
    archiveStatus: null,
    retentionUntil: null,
    version: 1,
    metadata: options?.transcriptMetadata ?? {},
  });

  await callTurnRepo.replaceForSession(session.id, buildTurnsFromTranscript(plan, transcript));
  const summary = await summarizeTelephonyTranscript(session, transcript);

  await callArtifactRepo.upsertForSession(session.id, 'summary', {
    status: 'ready',
    url: null,
    storagePath: null,
    content: summary.resultSummary,
    mimeType: 'text/plain',
    sizeBytes: summary.resultSummary.length,
    durationMs: null,
    checksumSha256: null,
    archiveStatus: null,
    retentionUntil: null,
    version: 1,
    metadata: { outcomeLabel: summary.outcomeLabel },
  });

  await callOutcomeRepo.saveForSession(session.id, {
    outcomeLabel: summary.outcomeLabel,
    resultSummary: summary.resultSummary,
    confidence: null,
    metadata: {},
  });

  const finalizedSession = await callSessionRepo.update(session.id, {
    recordLink: options?.recordLink ?? session.recordLink,
    transcript,
    resultSummary: summary.resultSummary,
    outcomeLabel: summary.outcomeLabel,
    status: options?.finalStatus ?? 'processed',
  });

  await callEventRepo.record(session.id, 'transcript_finalized', {
    outcomeLabel: summary.outcomeLabel,
    transcriptLength: transcript.length,
  });

  await sendTelephonyOwnerMessage(
    finalizedSession.ownerTelegramId,
    `📞 <b>AI-звонок завершён</b>\n` +
      `Сценарий: <b>${escapeHtml(finalizedSession.scenarioName)}</b>\n` +
      `Номер: <code>${escapeHtml(finalizedSession.targetPhone)}</code>\n` +
      `Итог: ${escapeHtml(finalizedSession.resultSummary || 'Итог не определён')}\n` +
      `Статус: <b>${escapeHtml(finalizedSession.outcomeLabel || 'неясно')}</b>\n` +
      (options?.recordLink ? `🎙 <a href="${options.recordLink}">Слушать запись</a>\n\n` : '\n') +
      `Расшифровка:\n<blockquote>${escapeHtml(truncateText(transcript, 1200))}</blockquote>`,
  );

  return finalizedSession;
}
