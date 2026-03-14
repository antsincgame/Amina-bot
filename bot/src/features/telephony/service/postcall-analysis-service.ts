import { transcribeAudio } from '../../../ai/multimodal.js';
import { aiLogger } from '../../../config/logger.js';
import { analyticsRepo } from '../../../db/index.js';
import type { TelephonyAiCallSession } from '../../../../../shared/types/telephony.js';
import { callArtifactRepo } from '../repository/call-artifact-repo.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { cleanText, escapeHtml } from '../shared.js';
import { telephonyRecordingsRepo } from '../telephony-recordings-repo.js';
import { sendTelephonyOwnerMessage } from './notification-service.js';
import { getRealtimeBridgeConfig } from './realtime-bridge-config.js';
import { finalizeTelephonyTranscript } from './telephony-session-finalizer.js';

const RECORDING_TIMEOUT_MS = 30_000;
function buildRetentionUntil(retentionDays: number): string {
  return new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000).toISOString();
}

async function downloadRecording(recordLink: string): Promise<{ base64: string; mimeType: string; buffer: Buffer } | null> {
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

  return { base64: buffer.toString('base64'), mimeType, buffer };
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

  await callSessionRepo.update(session.id, {
    recordLink,
    status: 'recorded',
  });

  await callArtifactRepo.upsertForSession(session.id, 'recording', {
    status: 'pending',
    url: recordLink,
    storagePath: null,
    content: null,
    mimeType: null,
    sizeBytes: null,
    durationMs: null,
    checksumSha256: null,
    archiveStatus: 'pending',
    retentionUntil: null,
    version: 1,
    metadata: { sourceUrl: recordLink },
  });

  try {
    const audio = await downloadRecording(recordLink);
    if (!audio) {
      throw new Error('Запись пустая');
    }

    const realtimeConfig = await getRealtimeBridgeConfig();
    const archive = await telephonyRecordingsRepo.uploadFromBuffer(
      session.id,
      audio.buffer,
      audio.mimeType,
      new Date(session.createdAt),
    );
    const retentionUntil = buildRetentionUntil(realtimeConfig.recordingRetentionDays);

    await callArtifactRepo.upsertForSession(session.id, 'recording', {
      status: 'ready',
      url: archive.signedUrl ?? recordLink,
      storagePath: archive.path,
      content: null,
      mimeType: archive.mimeType,
      sizeBytes: archive.sizeBytes,
      durationMs: null,
      checksumSha256: archive.checksumSha256,
      archiveStatus: 'archived',
      retentionUntil,
      version: 1,
      metadata: {
        sourceUrl: recordLink,
        bucket: archive.bucket,
      },
    });
    await callEventRepo.record(session.id, 'recording_archived', {
      sourceUrl: recordLink,
      storagePath: archive.path,
      sizeBytes: archive.sizeBytes,
    });

    const transcription = await transcribeAudio(audio.base64, audio.mimeType);
    const transcript = cleanText(transcription.text);
    const processedSession = await finalizeTelephonyTranscript(session.id, transcript, {
      recordLink: archive.signedUrl ?? recordLink,
      finalStatus: 'processed',
      transcriptMetadata: {
        mimeType: audio.mimeType,
        model: transcription.model,
        durationSeconds: transcription.duration_seconds ?? null,
      },
    });

    await callEventRepo.record(session.id, 'record_processed', {
      recordLink,
      storagePath: archive.path,
      outcomeLabel: processedSession.outcomeLabel,
    });
    analyticsRepo.log('call_ended', 'voice', {
      sessionId: session.id,
      scenarioId: session.scenarioId,
      runtimeMode: session.runtimeMode,
      outcomeLabel: processedSession.outcomeLabel,
      archived: true,
    }).catch(() => {});

    return processedSession;
  } catch (error) {
    await callArtifactRepo.upsertForSession(session.id, 'analysis_report', {
      status: 'failed',
      url: recordLink,
      storagePath: null,
      content: error instanceof Error ? error.message : String(error),
      mimeType: 'text/plain',
      sizeBytes: null,
      durationMs: null,
      checksumSha256: null,
      archiveStatus: 'failed',
      retentionUntil: null,
      version: 1,
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
