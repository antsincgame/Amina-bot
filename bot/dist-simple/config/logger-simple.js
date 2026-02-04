"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.serverLogger = exports.aiLogger = exports.telegramLogger = exports.logger = void 0;
var pino_1 = require("pino");
var index_simple_js_1 = require("./index-simple.js");
// --------------------------------------------
// Logger Configuration (Simple Version)
// --------------------------------------------
exports.logger = (0, pino_1.default)({
    level: index_simple_js_1.config.server.logLevel,
    transport: index_simple_js_1.config.isDev
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
        env: index_simple_js_1.config.isDev ? 'dev' : 'prod',
    },
    redact: {
        paths: ['req.headers.authorization', 'apiKey', 'token', 'secret'],
        censor: '[REDACTED]',
    },
});
// Child loggers for different modules
exports.telegramLogger = exports.logger.child({ module: 'telegram' });
exports.aiLogger = exports.logger.child({ module: 'ai' });
exports.serverLogger = exports.logger.child({ module: 'server' });
