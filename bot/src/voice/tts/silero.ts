import { voiceLogger } from '../../config/logger.js';
import { config } from '../../config/index.js';
import type { SynthesisResult } from '../../../../shared/types/index.js';

// --------------------------------------------
// Silero Text-to-Speech Service
// --------------------------------------------

// Silero TTS is a PyTorch model
// For Node.js, we'll use a subprocess or HTTP service approach
// Alternative: Use ONNX runtime for native Node.js support

interface SileroConfig {
  modelPath: string;
  speaker: string;
  sampleRate: number;
  language: string;
}

let isInitialized = false;
let currentConfig: SileroConfig | null = null;

// Available speakers for Russian Silero model
export const SILERO_SPEAKERS = {
  ru: ['aidar', 'baya', 'kseniya', 'xenia', 'eugene'],
  en: ['en_0', 'en_1', 'en_2', 'en_3', 'en_4'],
} as const;

// --------------------------------------------
// Initialization
// --------------------------------------------

export const initSilero = async (): Promise<void> => {
  if (isInitialized) return;

  try {
    voiceLogger.info({ modelPath: config.voice.tts.modelPath }, 'Initializing Silero TTS...');

    currentConfig = {
      modelPath: config.voice.tts.modelPath,
      speaker: config.voice.tts.speaker,
      sampleRate: config.voice.tts.sampleRate,
      language: config.voice.tts.language,
    };

    // Verify model file exists
    const fs = await import('fs/promises');
    try {
      await fs.access(config.voice.tts.modelPath);
    } catch {
      voiceLogger.warn('Silero model not found, TTS will be unavailable');
      return;
    }

    isInitialized = true;
    voiceLogger.info('Silero TTS initialized successfully');
  } catch (error) {
    voiceLogger.error({ error }, 'Failed to initialize Silero TTS');
    throw error;
  }
};

// --------------------------------------------
// Text-to-Speech Synthesis
// --------------------------------------------

export const synthesizeSpeech = async (
  text: string,
  options?: {
    speaker?: string;
    sampleRate?: number;
    language?: string;
  }
): Promise<SynthesisResult> => {
  if (!isInitialized) {
    await initSilero();
  }

  if (!currentConfig) {
    throw new Error('Silero TTS not configured');
  }

  const speaker = options?.speaker ?? currentConfig.speaker;
  const sampleRate = options?.sampleRate ?? currentConfig.sampleRate;

  voiceLogger.debug({ text: text.substring(0, 50), speaker }, 'Synthesizing speech');

  const startTime = Date.now();

  try {
    // Method 1: Use Python subprocess (recommended for Silero)
    const audio = await synthesizeWithPython(text, speaker, sampleRate);

    const duration = Date.now() - startTime;

    voiceLogger.info(
      { textLength: text.length, duration, audioSize: audio.length },
      'Speech synthesis completed'
    );

    return {
      audio,
      duration_ms: estimateAudioDuration(text),
      sample_rate: sampleRate,
      format: 'wav',
    };
  } catch (error) {
    voiceLogger.error({ error }, 'Speech synthesis failed');
    throw error;
  }
};

// --------------------------------------------
// Python Subprocess for Silero
// --------------------------------------------

const synthesizeWithPython = async (
  text: string,
  speaker: string,
  sampleRate: number
): Promise<Buffer> => {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    // Python script for Silero TTS
    const pythonScript = `
import sys
import torch
import torchaudio

model_path = sys.argv[1]
text = sys.argv[2]
speaker = sys.argv[3]
sample_rate = int(sys.argv[4])

# Load model
model = torch.package.PackageImporter(model_path).load_pickle("tts_models", "model")
model.to('cpu')

# Generate audio
audio = model.apply_tts(text=text, speaker=speaker, sample_rate=sample_rate)

# Write to stdout as bytes
torchaudio.save(sys.stdout.buffer, audio.unsqueeze(0), sample_rate, format='wav')
`;

    const process = spawn('python3', [
      '-c',
      pythonScript,
      currentConfig!.modelPath,
      text,
      speaker,
      sampleRate.toString(),
    ]);

    const chunks: Buffer[] = [];

    process.stdout.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    process.stderr.on('data', (data: Buffer) => {
      voiceLogger.warn({ stderr: data.toString() }, 'Python TTS warning');
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
      } else {
        reject(new Error(`Python TTS process exited with code ${code}`));
      }
    });

    process.on('error', (error) => {
      reject(error);
    });
  });
};

// --------------------------------------------
// Alternative: HTTP Service Approach
// --------------------------------------------

// If you run Silero as a separate service (recommended for production)
export const synthesizeWithService = async (
  text: string,
  speaker: string,
  serviceUrl = 'http://localhost:5000/tts'
): Promise<Buffer> => {
  const response = await fetch(serviceUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, speaker }),
  });

  if (!response.ok) {
    throw new Error(`TTS service error: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
};

// --------------------------------------------
// Utility Functions
// --------------------------------------------

const estimateAudioDuration = (text: string): number => {
  // Rough estimation: ~150 words per minute
  const words = text.split(/\s+/).length;
  const minutes = words / 150;
  return Math.round(minutes * 60 * 1000);
};

export const getAvailableSpeakers = (language: 'ru' | 'en'): readonly string[] => {
  return SILERO_SPEAKERS[language];
};

// --------------------------------------------
// Health Check
// --------------------------------------------

export const isSileroReady = (): boolean => {
  return isInitialized;
};

export const getSileroInfo = (): {
  ready: boolean;
  speaker: string;
  language: string;
  availableSpeakers: readonly string[];
} => {
  return {
    ready: isSileroReady(),
    speaker: currentConfig?.speaker ?? config.voice.tts.speaker,
    language: currentConfig?.language ?? config.voice.tts.language,
    availableSpeakers: SILERO_SPEAKERS[config.voice.tts.language as 'ru' | 'en'] ?? [],
  };
};
