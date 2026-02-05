import { describe, it, expect } from 'vitest';
import { detectReminderIntent } from './reminder-parser.js';

describe('reminder-parser', () => {
  describe('detectReminderIntent', () => {
    it('should detect "напомни" intent', () => {
      expect(detectReminderIntent('напомни мне завтра в 10 купить молоко')).toBe(true);
    });

    it('should detect "напомнить" intent', () => {
      expect(detectReminderIntent('можешь напомнить про встречу?')).toBe(true);
    });

    it('should detect "не забыть" intent', () => {
      expect(detectReminderIntent('не забыть позвонить маме')).toBe(true);
    });

    it('should detect "через X минут" intent', () => {
      expect(detectReminderIntent('через 30 минут проверить почту')).toBe(true);
    });

    it('should detect "через X часов" intent', () => {
      expect(detectReminderIntent('через 2 часа позвонить')).toBe(true);
    });

    it('should detect "завтра в..." intent', () => {
      expect(detectReminderIntent('завтра в 9 сделать зарядку')).toBe(true);
    });

    it('should detect "remind" intent (English)', () => {
      expect(detectReminderIntent('remind me to call John')).toBe(true);
    });

    it('should detect "поставь напоминание" intent', () => {
      expect(detectReminderIntent('поставь напоминание на завтра')).toBe(true);
    });

    it('should NOT detect regular questions', () => {
      expect(detectReminderIntent('какая погода завтра?')).toBe(false);
    });

    it('should NOT detect regular chat', () => {
      expect(detectReminderIntent('привет, как дела?')).toBe(false);
    });

    it('should NOT detect "что такое" questions', () => {
      expect(detectReminderIntent('что такое TypeScript?')).toBe(false);
    });

    it('should be case-insensitive', () => {
      expect(detectReminderIntent('НАПОМНИ мне!')).toBe(true);
      expect(detectReminderIntent('Remind Me')).toBe(true);
    });
  });
});
