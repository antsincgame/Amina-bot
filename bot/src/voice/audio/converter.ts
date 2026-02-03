import ffmpeg from 'fluent-ffmpeg';
import { Readable, Writable } from 'stream';
import { voiceLogger } from '../../config/logger.js';

// --------------------------------------------
// Audio Format Converter
// --------------------------------------------

// Supported formats
export type AudioFormat = 'wav' | 'ogg' | 'mp3' | 'opus';

interface ConversionOptions {
  sampleRate?: number;
  channels?: number;
  bitrate?: string;
}

// --------------------------------------------
// Convert to WAV (for STT)
// --------------------------------------------

export const convertToWav = async (
  input: Buffer,
  inputFormat: AudioFormat,
  options: ConversionOptions = {}
): Promise<Buffer> => {
  const { sampleRate = 16000, channels = 1 } = options;

  voiceLogger.debug(
    { inputFormat, inputSize: input.length, sampleRate },
    'Converting to WAV'
  );

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    // Create readable stream from buffer
    const inputStream = new Readable();
    inputStream.push(input);
    inputStream.push(null);

    // Create writable stream to collect output
    const outputStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    ffmpeg(inputStream)
      .inputFormat(inputFormat)
      .audioFrequency(sampleRate)
      .audioChannels(channels)
      .audioCodec('pcm_s16le')
      .format('wav')
      .on('error', (error: Error) => {
        voiceLogger.error({ error }, 'FFmpeg conversion error');
        reject(error);
      })
      .on('end', () => {
        const result = Buffer.concat(chunks);
        voiceLogger.debug({ outputSize: result.length }, 'WAV conversion complete');
        resolve(result);
      })
      .pipe(outputStream, { end: true });
  });
};

// --------------------------------------------
// Convert from WAV (for TTS output)
// --------------------------------------------

export const convertFromWav = async (
  input: Buffer,
  outputFormat: AudioFormat,
  options: ConversionOptions = {}
): Promise<Buffer> => {
  const { sampleRate = 48000, bitrate = '128k' } = options;

  voiceLogger.debug(
    { outputFormat, inputSize: input.length },
    'Converting from WAV'
  );

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    const inputStream = new Readable();
    inputStream.push(input);
    inputStream.push(null);

    const outputStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    let command = ffmpeg(inputStream)
      .inputFormat('wav')
      .audioFrequency(sampleRate);

    // Set codec based on output format
    switch (outputFormat) {
      case 'ogg':
        command = command.audioCodec('libopus').format('ogg');
        break;
      case 'mp3':
        command = command.audioCodec('libmp3lame').audioBitrate(bitrate).format('mp3');
        break;
      case 'opus':
        command = command.audioCodec('libopus').format('opus');
        break;
      default:
        reject(new Error(`Unsupported output format: ${outputFormat}`));
        return;
    }

    command
      .on('error', (error: Error) => {
        voiceLogger.error({ error }, 'FFmpeg conversion error');
        reject(error);
      })
      .on('end', () => {
        const result = Buffer.concat(chunks);
        voiceLogger.debug({ outputSize: result.length }, 'Conversion complete');
        resolve(result);
      })
      .pipe(outputStream, { end: true });
  });
};

// --------------------------------------------
// Telegram Voice Message Conversion
// --------------------------------------------

export const convertTelegramVoice = async (
  oggOpusBuffer: Buffer
): Promise<Buffer> => {
  // Telegram voice messages are OGG Opus
  // Convert to WAV 16kHz mono for STT
  return convertToWav(oggOpusBuffer, 'ogg', {
    sampleRate: 16000,
    channels: 1,
  });
};

export const convertToTelegramVoice = async (
  wavBuffer: Buffer
): Promise<Buffer> => {
  // Convert to OGG Opus for Telegram
  return convertFromWav(wavBuffer, 'ogg', {
    sampleRate: 48000,
  });
};

// --------------------------------------------
// Zadarma Audio Conversion
// --------------------------------------------

export const convertZadarmaAudio = async (
  input: Buffer,
  direction: 'from' | 'to'
): Promise<Buffer> => {
  // Zadarma uses various formats, typically PCM or G.711
  if (direction === 'from') {
    // Convert incoming audio to WAV for processing
    return convertToWav(input, 'wav', {
      sampleRate: 8000, // Phone quality
      channels: 1,
    });
  } else {
    // Convert processed audio for playback
    // Upsample back if needed
    return input; // WAV should work directly
  }
};

// --------------------------------------------
// Utility Functions
// --------------------------------------------

export const getAudioDuration = async (
  buffer: Buffer,
  format: AudioFormat
): Promise<number> => {
  return new Promise((resolve, reject) => {
    const inputStream = new Readable();
    inputStream.push(buffer);
    inputStream.push(null);

    ffmpeg(inputStream)
      .inputFormat(format)
      .ffprobe((err, data) => {
        if (err) {
          reject(err);
          return;
        }
        const duration = data.format.duration ?? 0;
        resolve(Math.round(duration * 1000)); // Return milliseconds
      });
  });
};

export const isFFmpegAvailable = async (): Promise<boolean> => {
  return new Promise((resolve) => {
    ffmpeg.getAvailableFormats((err) => {
      resolve(!err);
    });
  });
};
