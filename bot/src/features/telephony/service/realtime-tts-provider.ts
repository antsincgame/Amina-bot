import { getTtsRuntimeProfile, textToSpeech } from '../../tts.js';

export interface RealtimeSynthesisResult {
  audio: Buffer | null;
  provider: string;
  model: string;
}

export async function synthesizeRealtimeSpeech(
  text: string,
  lang: 'ru' | 'en' = 'ru',
): Promise<RealtimeSynthesisResult> {
  const profile = await getTtsRuntimeProfile();
  const audio = await textToSpeech(text, lang);

  return {
    audio,
    provider: profile.provider,
    model: profile.provider === 'elevenlabs'
      ? profile.elevenlabsModelId
      : profile.provider === 'openai'
        ? profile.openaiModel
        : profile.edgeVoice,
  };
}
