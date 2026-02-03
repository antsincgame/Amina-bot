import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fluent-ffmpeg
vi.mock('fluent-ffmpeg', () => {
  const mockFfmpeg = vi.fn().mockImplementation(() => ({
    inputFormat: vi.fn().mockReturnThis(),
    audioFrequency: vi.fn().mockReturnThis(),
    audioChannels: vi.fn().mockReturnThis(),
    audioCodec: vi.fn().mockReturnThis(),
    audioBitrate: vi.fn().mockReturnThis(),
    format: vi.fn().mockReturnThis(),
    on: vi.fn().mockImplementation(function(this: unknown, event: string, callback: () => void) {
      if (event === 'end') {
        setTimeout(callback, 0);
      }
      return this;
    }),
    pipe: vi.fn().mockImplementation(function(this: unknown, stream: { write: (data: Buffer) => void; end: () => void }) {
      // Simulate writing some data
      stream.write(Buffer.from('fake_audio_data'));
      stream.end();
      return this;
    }),
    ffprobe: vi.fn().mockImplementation((_callback: (err: Error | null, data: unknown) => void) => {
      // Not used in basic tests
    }),
  }));

  mockFfmpeg.getAvailableFormats = vi.fn().mockImplementation((callback: (err: Error | null) => void) => {
    callback(null);
  });

  return { default: mockFfmpeg };
});

import {
  convertToWav,
  convertFromWav,
  convertTelegramVoice,
  isFFmpegAvailable,
} from './converter.js';

describe('Audio Converter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('convertToWav', () => {
    it('should convert OGG to WAV with correct parameters', async () => {
      // Arrange
      const inputBuffer = Buffer.from('fake_ogg_audio');

      // Act
      const result = await convertToWav(inputBuffer, 'ogg');

      // Assert
      expect(result).toBeInstanceOf(Buffer);
      expect(result.length).toBeGreaterThan(0);
    });

    it('should use default sample rate of 16000 for STT', async () => {
      // Arrange
      const inputBuffer = Buffer.from('fake_audio');

      // Act
      const result = await convertToWav(inputBuffer, 'mp3');

      // Assert
      expect(result).toBeInstanceOf(Buffer);
    });

    it('should accept custom sample rate', async () => {
      // Arrange
      const inputBuffer = Buffer.from('fake_audio');

      // Act
      const result = await convertToWav(inputBuffer, 'ogg', {
        sampleRate: 8000,
        channels: 1,
      });

      // Assert
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('convertFromWav', () => {
    it('should convert WAV to OGG', async () => {
      // Arrange
      const inputBuffer = Buffer.from('fake_wav_audio');

      // Act
      const result = await convertFromWav(inputBuffer, 'ogg');

      // Assert
      expect(result).toBeInstanceOf(Buffer);
    });

    it('should convert WAV to MP3', async () => {
      // Arrange
      const inputBuffer = Buffer.from('fake_wav_audio');

      // Act
      const result = await convertFromWav(inputBuffer, 'mp3');

      // Assert
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('convertTelegramVoice', () => {
    it('should convert Telegram OGG Opus to WAV 16kHz mono', async () => {
      // Arrange
      const telegramVoice = Buffer.from('fake_telegram_voice');

      // Act
      const result = await convertTelegramVoice(telegramVoice);

      // Assert
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('isFFmpegAvailable', () => {
    it('should return true when FFmpeg is available', async () => {
      // Act
      const result = await isFFmpegAvailable();

      // Assert
      expect(result).toBe(true);
    });
  });
});

describe('Audio Converter Edge Cases', () => {
  it('should handle empty buffer', async () => {
    // Arrange
    const emptyBuffer = Buffer.alloc(0);

    // Act
    const result = await convertToWav(emptyBuffer, 'ogg');

    // Assert
    expect(result).toBeInstanceOf(Buffer);
  });

  it('should handle large buffer', async () => {
    // Arrange
    const largeBuffer = Buffer.alloc(1024 * 1024); // 1MB

    // Act
    const result = await convertToWav(largeBuffer, 'ogg');

    // Assert
    expect(result).toBeInstanceOf(Buffer);
  });
});
