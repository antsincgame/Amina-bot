import * as pino from 'pino';
import { config } from './index.js';
import { queueLog, createLogFromPino } from './db-logger.js';

// --------------------------------------------
// Logger Configuration
// --------------------------------------------

// Custom hook to intercept logs and send to DB
const hooks = {
  logMethod(
    inputArgs: Parameters<pino.LogFn>,
    method: pino.LogFn,
    level: number
  ) {
    // Only intercept warn, error, fatal (level >= 30)
    if (level >= 30) {
      // Schedule DB logging (non-blocking)
      setImmediate(() => {
        try {
          const logObj = typeof inputArgs[0] === 'object' ? inputArgs[0] : {};
          const msg = typeof inputArgs[0] === 'string' ? inputArgs[0] : inputArgs[1];
          
          const pinoLog = {
            ...logObj,
            level,
            msg: msg || '',
            time: Date.now(),
          };
          
          const dbLog = createLogFromPino(pinoLog);
          queueLog(dbLog);
        } catch {
          // Ignore errors in DB logging to prevent infinite loops
        }
      });
    }
    
    return method.apply(this, inputArgs);
  },
};

const pinoLogger = pino.pino({
  level: config.server.logLevel,
  hooks,
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

// Re-export DB logger functions for direct use
export { logError, logWarning, logFatal, getLogs, getLogStats, flushLogs } from './db-logger.js';
