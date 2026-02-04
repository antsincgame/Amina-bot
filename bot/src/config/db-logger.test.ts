import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createLogFromPino, queueLog } from './db-logger.js';

describe('db-logger', () => {
  describe('createLogFromPino', () => {
    it('should use module from pinoLog when present', () => {
      const pinoLog = {
        level: 30,
        msg: 'Test message',
        time: Date.now(),
        module: 'telegram',
      };
      const log = createLogFromPino(pinoLog);
      expect(log.module).toBe('telegram');
      expect(log.message).toBe('Test message');
      expect(log.level).toBe('warn');
    });

    it('should default module to unknown when not in pinoLog', () => {
      const pinoLog = {
        level: 40,
        msg: 'Error message',
        time: Date.now(),
      };
      const log = createLogFromPino(pinoLog);
      expect(log.module).toBe('unknown');
      expect(log.level).toBe('error');
    });

    it('should map pino levels correctly', () => {
      expect(createLogFromPino({ level: 10, msg: '', time: 0 }).level).toBe('debug');
      expect(createLogFromPino({ level: 20, msg: '', time: 0 }).level).toBe('info');
      expect(createLogFromPino({ level: 30, msg: '', time: 0 }).level).toBe('warn');
      expect(createLogFromPino({ level: 40, msg: '', time: 0 }).level).toBe('error');
      expect(createLogFromPino({ level: 60, msg: '', time: 0 }).level).toBe('fatal');
    });

    it('should extract error stack from err', () => {
      const err = new Error('test');
      const pinoLog = {
        level: 50,
        msg: 'Fatal',
        time: Date.now(),
        err: { stack: err.stack },
      };
      const log = createLogFromPino(pinoLog);
      expect(log.error_stack).toBeDefined();
      expect(log.error_stack).toContain('Error: test');
    });
  });

  describe('queueLog', () => {
    it('should not throw when given valid log', () => {
      expect(() => {
        queueLog({
          level: 'warn',
          module: 'test',
          message: 'test',
          timestamp: new Date().toISOString(),
        });
      }).not.toThrow();
    });
  });
});
