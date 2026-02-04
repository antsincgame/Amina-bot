import { describe, it, expect } from 'vitest';
import { VISION_MODELS, AUDIO_MODELS } from './multimodal.js';

describe('multimodal', () => {
  describe('constants', () => {
    it('AUDIO_MODELS premium should include suggested fallback openai/gpt-audio-mini', () => {
      const premiumIds = AUDIO_MODELS.premium.map((m) => m.id);
      expect(premiumIds).toContain('openai/gpt-audio-mini');
    });

    it('VISION_MODELS should have free and premium arrays', () => {
      expect(VISION_MODELS.free).toBeInstanceOf(Array);
      expect(VISION_MODELS.premium).toBeInstanceOf(Array);
      expect(VISION_MODELS.free.length).toBeGreaterThanOrEqual(0);
      expect(VISION_MODELS.premium.length).toBeGreaterThan(0);
    });

    it('AUDIO_MODELS free should include Groq', () => {
      const freeIds = AUDIO_MODELS.free.map((m) => m.id);
      expect(freeIds.some((id) => id.startsWith('groq/'))).toBe(true);
    });
  });
});
