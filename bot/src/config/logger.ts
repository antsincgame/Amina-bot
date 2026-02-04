import * as pino from 'pino';
import { config } from './index.js';

// --------------------------------------------
// Logger Configuration
// --------------------------------------------

const pinoLogger = pino.pino({
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

export const logger = pinoLogger;

// Child loggers for different modules
export const telegramLogger = logger.child({ module: 'telegram' });
export const aiLogger = logger.child({ module: 'ai' });
export const dbLogger = logger.child({ module: 'db' });
export const serverLogger = logger.child({ module: 'server' });
export const httpLogger = logger.child({ module: 'http' });
