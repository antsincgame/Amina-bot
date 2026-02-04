"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
var zod_1 = require("zod");
var dotenv = require("dotenv");
// Load environment variables
dotenv.config();
// --------------------------------------------
// Environment Schema Validation (Simple Version)
// --------------------------------------------
var envSchema = zod_1.z.object({
    // Telegram
    TELEGRAM_BOT_TOKEN: zod_1.z.string().min(1, 'TELEGRAM_BOT_TOKEN is required'),
    // OpenRouter
    OPENROUTER_API_KEY: zod_1.z.string().min(1, 'OPENROUTER_API_KEY is required'),
    OPENROUTER_MODEL: zod_1.z.string().default('anthropic/claude-3-haiku'),
    // Server
    PORT: zod_1.z.string().default('3000').transform(Number),
    HOST: zod_1.z.string().default('0.0.0.0'),
    NODE_ENV: zod_1.z.enum(['development', 'production', 'test']).default('development'),
    LOG_LEVEL: zod_1.z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});
// --------------------------------------------
// Parse and Validate Environment
// --------------------------------------------
var parseEnv = function () {
    var result = envSchema.safeParse(process.env);
    if (!result.success) {
        console.error('❌ Invalid environment variables:');
        console.error(result.error.format());
        process.exit(1);
    }
    return result.data;
};
// --------------------------------------------
// Configuration Object (Simple Version)
// --------------------------------------------
var env = parseEnv();
exports.config = {
    // Environment
    isDev: env.NODE_ENV === 'development',
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    // Server
    server: {
        port: env.PORT,
        host: env.HOST,
        logLevel: env.LOG_LEVEL,
    },
    // Telegram Bot
    telegram: {
        token: env.TELEGRAM_BOT_TOKEN,
    },
    // OpenRouter AI
    ai: {
        apiKey: env.OPENROUTER_API_KEY,
        model: env.OPENROUTER_MODEL,
        baseUrl: 'https://openrouter.ai/api/v1',
        maxTokens: 2048,
        temperature: 0.7,
    },
};
