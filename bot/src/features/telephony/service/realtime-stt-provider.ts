import { getSpeechRecognitionRuntimeProfile, transcribeAudio } from '../../../ai/multimodal.js';

export type RealtimeTranscriptMode = 'partial' | 'final';

export interface RealtimeTranscriptionResult {
  text: string;
  provider: 'groq';
  model: string;
  mode: RealtimeTranscriptMode;
  durationSeconds?: number;
}

export async function transcribeRealtimeAudio(
  audioBase64: string,
  mimeType: string,
  mode: RealtimeTranscriptMode = 'final',
): Promise<RealtimeTranscriptionResult> {
  const profile = await getSpeechRecognitionRuntimeProfile();
  const result = await transcribeAudio(audioBase64, mimeType);

  return {
    text: result.text,
    provider: 'groq',
    model: profile.audioModel || result.model,
    mode,
    durationSeconds: result.duration_seconds,
  };
}
