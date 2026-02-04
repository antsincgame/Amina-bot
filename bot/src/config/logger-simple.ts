import pino from 'pino';
import { config } from './index-simple.js';

// --------------------------------------------
// Logger Configuration (Simple Version)
// --------------------------------------------

export const logger = pino({
  level: config.server.logLevel,
  transport: config.isDev
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  base: {
    env: config.isDev ? 'dev' : 'prod',
  },
  redact: {
    paths: ['req.headers.authorization', 'apiKey', 'token', 'secret'],
    censor: '[REDACTED]',
  },
});

// Child loggers for different modules
export const telegramLogger = logger.child({ module: 'telegram' });
export const aiLogger = logger.child({ module: 'ai' });
export const serverLogger = logger.child({ module: 'server' });
