import type {
  TelephonyAiCallSession,
  TelephonyCallArtifact,
  TelephonyCallEvent,
  TelephonyCallOutcome,
  TelephonyCallTurn,
} from '../../../../../shared/types/telephony.js';
import { callArtifactRepo } from '../repository/call-artifact-repo.js';
import { callEventRepo } from '../repository/call-event-repo.js';
import { callOutcomeRepo } from '../repository/call-outcome-repo.js';
import { callSessionRepo } from '../repository/call-session-repo.js';
import { callTurnRepo } from '../repository/call-turn-repo.js';
import { telephonyRecordingsRepo } from '../telephony-recordings-repo.js';

export interface TelephonySessionDetails {
  session: TelephonyAiCallSession;
  events: TelephonyCallEvent[];
  turns: TelephonyCallTurn[];
  artifacts: TelephonyCallArtifact[];
  outcome: TelephonyCallOutcome | null;
}

async function hydrateArtifactUrl(artifact: TelephonyCallArtifact): Promise<TelephonyCallArtifact> {
  if (!artifact.storagePath) {
    return artifact;
  }

  try {
    const signedUrl = await telephonyRecordingsRepo.createSignedUrl(artifact.storagePath);
    return {
      ...artifact,
      url: signedUrl ?? artifact.url,
    };
  } catch {
    return artifact;
  }
}

export async function getTelephonySessionDetails(sessionId: string): Promise<TelephonySessionDetails | null> {
  const session = await callSessionRepo.getById(sessionId);
  if (!session) {
    return null;
  }

  const [events, turns, artifacts, outcome] = await Promise.all([
    callEventRepo.listBySession(sessionId),
    callTurnRepo.listBySession(sessionId),
    callArtifactRepo.listBySession(sessionId),
    callOutcomeRepo.getBySession(sessionId),
  ]);

  const hydratedArtifacts = await Promise.all(artifacts.map(hydrateArtifactUrl));

  return {
    session,
    events,
    turns,
    artifacts: hydratedArtifacts,
    outcome,
  };
}
