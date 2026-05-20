import { describe, it, expect } from 'vitest';
import { AUDIO_MODELS, getFreeVisionModels, refreshFreeVisionModelsCache, getVisionFallbackStatus, getAllAudioModels, looksLikeUsableVisionDescription, visionErrorTriggersRace } from './multimodal.js';

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

  describe('looksLikeUsableVisionDescription', () => {
    it('принимает осмысленное описание (RU)', () => {
      expect(looksLikeUsableVisionDescription('На фото рыжий кот сидит на подоконнике у окна.')).toBe(true);
    });

    it('принимает осмысленное описание (EN) — без ложного срабатывания на язык', () => {
      expect(looksLikeUsableVisionDescription('A ginger cat is sitting on the windowsill near the window.')).toBe(true);
    });

    it('отклоняет слишком короткий ответ', () => {
      expect(looksLikeUsableVisionDescription('кот')).toBe(false);
    });

    it('отклоняет мусор из символов', () => {
      expect(looksLikeUsableVisionDescription('### @@@ %%% &&& *** !!! ??? ::: ;;; ~~~ ^^^')).toBe(false);
    });

    it('отклоняет повтор одного символа', () => {
      expect(looksLikeUsableVisionDescription('ааааааааааааааааааааааааааааааа')).toBe(false);
    });
  });

  describe('visionErrorTriggersRace', () => {
    it('срабатывает на статусы и текстовые признаки', () => {
      expect(visionErrorTriggersRace('500 Internal Server Error')).toBe(true);
      expect(visionErrorTriggersRace('404 not found')).toBe(true);
      expect(visionErrorTriggersRace('Provider returned error')).toBe(true);
    });

    it('НЕ срабатывает на число внутри токена (ложный 400/500/404)', () => {
      expect(visionErrorTriggersRace('processed 5004 pixels')).toBe(false);
      expect(visionErrorTriggersRace('model llava-400m failed to load weights')).toBe(false);
    });
  });
});
