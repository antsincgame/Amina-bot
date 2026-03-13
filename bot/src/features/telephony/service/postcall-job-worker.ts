import { aiLogger } from '../../../config/logger.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callJobRepo } from '../repository/call-job-repo.js';
import { processRecordingForSession } from './postcall-analysis-service.js';

const JOB_POLL_INTERVAL_MS = 10_000;
const JOB_BATCH_SIZE = 3;

let workerTimer: ReturnType<typeof setInterval> | null = null;
let workerRunning = false;

export async function enqueueRecordingProcessing(
  sessionId: string,
  recordLink: string,
): Promise<void> {
  await callJobRepo.enqueueUnique(
    sessionId,
    'process_recording',
    `recording:${sessionId}`,
    { recordLink },
  );

  await callEventRepo.record(sessionId, 'record_enqueued', { recordLink });
}

async function drainRecordingJobs(): Promise<void> {
  if (workerRunning) {
    return;
  }

  workerRunning = true;
  try {
    const jobs = await callJobRepo.reserveDueJobs('process_recording', JOB_BATCH_SIZE);

    for (const job of jobs) {
      const recordLink = typeof job.payload.recordLink === 'string' ? job.payload.recordLink : '';
      if (!recordLink) {
        await callJobRepo.markFailed(job, 'recordLink отсутствует в payload');
        continue;
      }

      try {
        await processRecordingForSession(job.sessionId, recordLink);
        await callJobRepo.markCompleted(job.id);
      } catch (error) {
        await callJobRepo.markFailed(
          job,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  } finally {
    workerRunning = false;
  }
}

export function startTelephonyJobWorker(): void {
  if (workerTimer) {
    return;
  }

  workerTimer = setInterval(() => {
    void drainRecordingJobs().catch((error) => {
      aiLogger.error({ error }, '[Telephony] Recording job worker iteration failed');
    });
  }, JOB_POLL_INTERVAL_MS);

  void drainRecordingJobs().catch((error) => {
    aiLogger.error({ error }, '[Telephony] Initial recording job drain failed');
  });
}

export function stopTelephonyJobWorker(): void {
  if (!workerTimer) {
    return;
  }

  clearInterval(workerTimer);
  workerTimer = null;
}
