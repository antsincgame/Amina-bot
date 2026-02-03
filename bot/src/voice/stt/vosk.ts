import { voiceLogger } from '../../config/logger.js';
import { config } from '../../config/index.js';
import type { TranscriptionResult } from '../../../../shared/types/index.js';

// --------------------------------------------
// Vosk Speech-to-Text Service
// --------------------------------------------

// Note: Vosk requires native bindings and model files
// For production, models should be downloaded during build

interface VoskModel {
  // Vosk model interface (from vosk package)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface VoskRecognizer {
  acceptWaveform(data: Buffer): boolean;
  result(): { text: string };
  partialResult(): { partial: string };
  finalResult(): { text: string };
  free(): void;
}

let model: VoskModel | null = null;
let isInitialized = false;

// --------------------------------------------
// Initialization
// --------------------------------------------

export const initVosk = async (): Promise<void> => {
  if (isInitialized) return;

  try {
    // Dynamic import for vosk (native module)
    const vosk = await import('vosk');
    
    voiceLogger.info({ modelPath: config.voice.stt.modelPath }, 'Loading Vosk model...');
    
    // Set log level
    vosk.setLogLevel(-1); // Disable verbose logging
    
    // Load model
    model = new vosk.Model(config.voice.stt.modelPath);
    isInitialized = true;
    
    voiceLogger.info('Vosk STT initialized successfully');
  } catch (error) {
    voiceLogger.error({ error }, 'Failed to initialize Vosk');
    throw new Error(`Vosk initialization failed: ${error}`);
  }
};

// --------------------------------------------
// Transcription
// --------------------------------------------

export const transcribeAudio = async (
  audioBuffer: Buffer,
  sampleRate = config.voice.stt.sampleRate
): Promise<TranscriptionResult> => {
  if (!model || !isInitialized) {
    await initVosk();
  }

  if (!model) {
    throw new Error('Vosk model not loaded');
  }

  const startTime = Date.now();
  voiceLogger.debug({ bufferSize: audioBuffer.length, sampleRate }, 'Starting transcription');

  try {
    const vosk = await import('vosk');
    const recognizer: VoskRecognizer = new vosk.Recognizer({
      model,
      sampleRate,
    });

    // Process audio in chunks
    const chunkSize = 4000;
    let offset = 0;

    while (offset < audioBuffer.length) {
      const chunk = audioBuffer.subarray(offset, offset + chunkSize);
      recognizer.acceptWaveform(chunk);
      offset += chunkSize;
    }

    // Get final result
    const result = recognizer.finalResult();
    recognizer.free();

    const duration = Date.now() - startTime;
    
    voiceLogger.info(
      { text: result.text.substring(0, 50), duration },
      'Transcription completed'
    );

    return {
      text: result.text,
      confidence: 0.9, // Vosk doesn't provide confidence by default
      language: config.voice.stt.language,
      duration_ms: duration,
    };
  } catch (error) {
    voiceLogger.error({ error }, 'Transcription failed');
    throw error;
  }
};

// --------------------------------------------
// Streaming Transcription
// --------------------------------------------

export const createStreamingRecognizer = async (): Promise<{
  feed: (chunk: Buffer) => string | null;
  finish: () => string;
  close: () => void;
}> => {
  if (!model || !isInitialized) {
    await initVosk();
  }

  if (!model) {
    throw new Error('Vosk model not loaded');
  }

  const vosk = await import('vosk');
  const recognizer: VoskRecognizer = new vosk.Recognizer({
    model,
    sampleRate: config.voice.stt.sampleRate,
  });

  return {
    feed: (chunk: Buffer): string | null => {
      if (recognizer.acceptWaveform(chunk)) {
        const result = recognizer.result();
        return result.text || null;
      }
      return null;
    },

    finish: (): string => {
      const result = recognizer.finalResult();
      return result.text;
    },

    close: (): void => {
      recognizer.free();
    },
  };
};

// --------------------------------------------
// Health Check
// --------------------------------------------

export const isVoskReady = (): boolean => {
  return isInitialized && model !== null;
};

export const getVoskInfo = (): { ready: boolean; modelPath: string; language: string } => {
  return {
    ready: isVoskReady(),
    modelPath: config.voice.stt.modelPath,
    language: config.voice.stt.language,
  };
};
