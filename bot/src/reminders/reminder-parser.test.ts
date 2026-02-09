/**
 * Tests for Reminder Parser
 * 
 * Покрытие:
 * - detectReminderIntent: все паттерны + ложноположительные
 * - Edge cases: похожие на напоминание, но не напоминание
 */

import { describe, it, expect } from 'vitest';
import { detectReminderIntent } from './reminder-parser.js';

describe('reminder-parser', () => {
  describe('detectReminderIntent', () => {
    // === Должен обнаружить ===
    
    it('should detect "напомни мне"', () => {
      expect(detectReminderIntent('напомни мне завтра в 10 купить молоко')).toBe(true);
    });

    it('should detect "напомнить"', () => {
      expect(detectReminderIntent('можешь напомнить про встречу?')).toBe(true);
    });

    it('should detect "не забыть"', () => {
      expect(detectReminderIntent('не забыть позвонить маме')).toBe(true);
    });

    it('should detect "не забудь"', () => {
      expect(detectReminderIntent('не забудь взять зонтик')).toBe(true);
    });

    it('should detect "через X минут"', () => {
      expect(detectReminderIntent('через 30 минут проверить почту')).toBe(true);
      expect(detectReminderIntent('через 5 минут позвонить')).toBe(true);
    });

    it('should detect "через X часов"', () => {
      expect(detectReminderIntent('через 2 часа позвонить')).toBe(true);
      expect(detectReminderIntent('через 1 час на встречу')).toBe(true);
    });

    it('should detect "через X дней"', () => {
      expect(detectReminderIntent('через 3 дня сдать проект')).toBe(true);
    });

    it('should detect "через X недель"', () => {
      expect(detectReminderIntent('через 2 недели на приём к врачу')).toBe(true);
    });

    it('should detect "завтра в..."', () => {
      expect(detectReminderIntent('завтра в 9 сделать зарядку')).toBe(true);
      expect(detectReminderIntent('завтра в 15:00 встреча')).toBe(true);
    });

    it('should detect "послезавтра в..."', () => {
      expect(detectReminderIntent('послезавтра в 8 выезжаю')).toBe(true);
    });

    it('should detect "remind" (English)', () => {
      expect(detectReminderIntent('remind me to call John')).toBe(true);
    });

    it('should detect "поставь напоминание"', () => {
      expect(detectReminderIntent('поставь напоминание на завтра')).toBe(true);
    });

    it('should detect "создай напоминание"', () => {
      expect(detectReminderIntent('создай напоминание купить продукты')).toBe(true);
    });

    it('should detect "в HH:MM сделать..."', () => {
      expect(detectReminderIntent('в 15:00 сделать уборку')).toBe(true);
      expect(detectReminderIntent('в 9.30 позвонить врачу')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(detectReminderIntent('НАПОМНИ мне!')).toBe(true);
      expect(detectReminderIntent('Remind Me')).toBe(true);
      expect(detectReminderIntent('НЕ ЗАБЫТЬ купить хлеб')).toBe(true);
    });

    // === НЕ должен ложно срабатывать ===

    it('should NOT detect regular questions', () => {
      expect(detectReminderIntent('какая погода завтра?')).toBe(false);
    });

    it('should NOT detect regular chat', () => {
      expect(detectReminderIntent('привет, как дела?')).toBe(false);
    });

    it('should NOT detect "что такое" questions', () => {
      expect(detectReminderIntent('что такое TypeScript?')).toBe(false);
    });

    it('should NOT detect questions about recommendations', () => {
      expect(detectReminderIntent('назови лучшие кофейни гродно')).toBe(false);
    });

    it('should NOT detect code-related queries', () => {
      expect(detectReminderIntent('напиши код на Python')).toBe(false);
    });

    it('should NOT detect "расскажи"', () => {
      expect(detectReminderIntent('расскажи про историю Минска')).toBe(false);
    });

    it('should NOT detect search queries', () => {
      expect(detectReminderIntent('найди информацию про React')).toBe(false);
    });

    it('should NOT detect image generation', () => {
      expect(detectReminderIntent('нарисуй красивый закат')).toBe(false);
    });

    it('should NOT detect short messages', () => {
      expect(detectReminderIntent('да')).toBe(false);
      expect(detectReminderIntent('ок')).toBe(false);
      expect(detectReminderIntent('спасибо')).toBe(false);
    });
  });
});
