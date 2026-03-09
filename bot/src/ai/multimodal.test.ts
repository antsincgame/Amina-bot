import { describe, it, expect } from 'vitest';
import { AUDIO_MODELS, getFreeVisionModels, refreshFreeVisionModelsCache, getVisionFallbackStatus, getAllAudioModels } from './multimodal.js';

describe('multimodal', () => {
  describe('constants', () => {
    it('AUDIO_MODELS free should include Groq whisper models', () => {
      const freeIds = AUDIO_MODELS.free.map((m) => m.id);
      expect(freeIds.some((id) => id.startsWith('groq/'))).toBe(true);
      expect(freeIds).toContain('groq/whisper-large-v3');
    });

    it('getAllAudioModels should return only free models', () => {
      const models = getAllAudioModels();
      expect(models.free).toBeInstanceOf(Array);
      expect(models.free.length).toBeGreaterThan(0);
      expect((models as any).premium).toBeUndefined();
    });
  });

  describe('vision model exports', () => {
    it('getFreeVisionModels should return array of models', async () => {
      const models = await getFreeVisionModels();
      expect(models).toBeInstanceOf(Array);
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty('id');
      expect(models[0]).toHaveProperty('name');
    }, 15_000);

    it('getVisionFallbackStatus should return status object', () => {
      const status = getVisionFallbackStatus();
      expect(status).toHaveProperty('reason');
      expect(status).toHaveProperty('time');
      expect(status).toHaveProperty('fromModel');
      expect(status).toHaveProperty('toModel');
    });
  });
});
