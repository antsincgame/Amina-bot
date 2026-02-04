import { voiceLogger } from '../config/logger.js';
import { aiService } from '../ai/openrouter.js';
import { transcribeAudio, initVosk, isVoskReady } from './stt/vosk.js';
import { synthesizeSpeech, initSilero, isSileroReady } from './tts/silero.js';
import { convertToWav } from './audio/converter.js';
import type { TranscriptionResult, SynthesisResult } from '../../../shared/types/index.js';

// --------------------------------------------
// Voice Handler - Main Entry Point
// --------------------------------------------

export interface VoiceProcessingResult {
  transcription: TranscriptionResult;
  aiResponse: string;
  synthesis?: SynthesisResult;
}

// --------------------------------------------
// Initialization
// --------------------------------------------

export const initVoiceServices = async (): Promise<{
  stt: boolean;
  tts: boolean;
}> => {
  const results = { stt: false, tts: false };

  try {
    await initVosk();
    results.stt = true;
    voiceLogger.info('STT (Vosk) initialized');
  } catch (error) {
    voiceLogger.error({ error }, 'Failed to initialize STT');
  }

  try {
    await initSilero();
    results.tts = true;
    voiceLogger.info('TTS (Silero) initialized');
  } catch (error) {
    voiceLogger.error({ error }, 'Failed to initialize TTS');
  }

  return results;
};

// --------------------------------------------
// Process Voice Message
// --------------------------------------------

export const processVoiceMessage = async (
  audioBuffer: Buffer,
  inputFormat: 'ogg' | 'wav' | 'mp3' = 'ogg',
  conversationHistory: { role: 'user' | 'assistant'; content: string }[] = [],
  options?: {
    generateAudio?: boolean;
    speaker?: string;
  }
): Promise<VoiceProcessingResult> => {
  const startTime = Date.now();

  voiceLogger.info(
    { inputFormat, bufferSize: audioBuffer.length },
    'Processing voice message'
  );

  // Step 1: Convert audio to WAV if needed
  let wavBuffer: Buffer;
  if (inputFormat !== 'wav') {
    voiceLogger.debug('Converting audio to WAV');
    wavBuffer = await convertToWav(audioBuffer, inputFormat);
  } else {
    wavBuffer = audioBuffer;
  }

  // Step 2: Transcribe audio
  voiceLogger.debug('Transcribing audio');
  const transcription = await transcribeAudio(wavBuffer);

  if (!transcription.text.trim()) {
    throw new Error('No speech detected in audio');
  }

  voiceLogger.info(
    { text: transcription.text.substring(0, 100) },
    'Transcription complete'
  );

  // Step 3: Get AI response
  voiceLogger.debug('Getting AI response');
  const messages = [
    ...conversationHistory,
    { role: 'user' as const, content: transcription.text },
  ];

  const aiResponse = await aiService.chat(messages, 'voice');

  voiceLogger.info(
    { responseLength: aiResponse.content.length },
    'AI response received'
  );

  // Step 4: Synthesize speech (optional)
  let synthesis: SynthesisResult | undefined;
  if (options?.generateAudio !== false && isSileroReady()) {
    voiceLogger.debug('Synthesizing speech');
    synthesis = await synthesizeSpeech(aiResponse.content, {
      speaker: options?.speaker,
    });
    voiceLogger.info({ audioSize: synthesis.audio.length }, 'Speech synthesized');
  }

  const totalTime = Date.now() - startTime;
  voiceLogger.info({ totalTime }, 'Voice processing complete');

  return {
    transcription,
    aiResponse: aiResponse.content,
    synthesis,
  };
};

// --------------------------------------------
// Health Check
// --------------------------------------------

export const getVoiceServicesStatus = (): {
  stt: { ready: boolean; engine: string };
  tts: { ready: boolean; engine: string };
} => {
  return {
    stt: {
      ready: isVoskReady(),
      engine: 'Vosk',
    },
    tts: {
      ready: isSileroReady(),
      engine: 'Silero',
    },
  };
};
