"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var fastify_1 = require("fastify");
var cors_1 = require("@fastify/cors");
var index_simple_js_1 = require("./config/index-simple.js");
var logger_simple_js_1 = require("./config/logger-simple.js");
var bot_simple_js_1 = require("./telegram/bot-simple.js");
var openrouter_simple_js_1 = require("./ai/openrouter-simple.js");
// --------------------------------------------
// Initialize Services
// --------------------------------------------
var app = (0, fastify_1.default)({
    logger: false, // Use custom pino logger
    trustProxy: true,
});
// Bot instance
var bot = null;
// --------------------------------------------
// Setup Server
// --------------------------------------------
var setupServer = function (app) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0: 
            // Register CORS
            return [4 /*yield*/, app.register(cors_1.default, {
                    origin: true,
                    credentials: true,
                })];
            case 1:
                // Register CORS
                _a.sent();
                // Health Check Routes
                app.get('/health', function () { return __awaiter(void 0, void 0, void 0, function () {
                    return __generator(this, function (_a) {
                        return [2 /*return*/, { status: 'ok', timestamp: new Date().toISOString() }];
                    });
                }); });
                app.get('/api/status', function () { return __awaiter(void 0, void 0, void 0, function () {
                    var status, aiOk, _a;
                    return __generator(this, function (_b) {
                        switch (_b.label) {
                            case 0:
                                status = {
                                    server: 'ok',
                                    bot: bot ? 'initialized' : 'not_initialized',
                                    openrouter: 'checking',
                                };
                                _b.label = 1;
                            case 1:
                                _b.trys.push([1, 3, , 4]);
                                return [4 /*yield*/, openrouter_simple_js_1.aiService.testConnection()];
                            case 2:
                                aiOk = _b.sent();
                                status.openrouter = aiOk ? 'ok' : 'error';
                                return [3 /*break*/, 4];
                            case 3:
                                _a = _b.sent();
                                status.openrouter = 'error';
                                return [3 /*break*/, 4];
                            case 4: return [2 /*return*/, status];
                        }
                    });
                }); });
                return [2 /*return*/];
        }
    });
}); };
// --------------------------------------------
// Start Application
// --------------------------------------------
var start = function () { return __awaiter(void 0, void 0, void 0, function () {
    var aiOk, port, host, error_1;
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                _a.trys.push([0, 4, , 5]);
                // Validate configuration
                logger_simple_js_1.logger.info('Starting Amina Bot (Simple Version - No Database)...');
                logger_simple_js_1.logger.info({ config: __assign(__assign({}, index_simple_js_1.config), { telegram: { token: '[REDACTED]' }, ai: __assign(__assign({}, index_simple_js_1.config.ai), { apiKey: '[REDACTED]' }) }) }, 'Configuration loaded');
                // Setup server routes
                return [4 /*yield*/, setupServer(app)];
            case 1:
                // Setup server routes
                _a.sent();
                // Test OpenRouter connection
                logger_simple_js_1.logger.info('Testing OpenRouter connection...');
                return [4 /*yield*/, openrouter_simple_js_1.aiService.testConnection()];
            case 2:
                aiOk = _a.sent();
                if (!aiOk) {
                    throw new Error('OpenRouter connection test failed');
                }
                logger_simple_js_1.logger.info('✓ OpenRouter connection OK');
                // Create bot
                logger_simple_js_1.logger.info('Initializing Telegram bot...');
                bot = (0, bot_simple_js_1.createBot)();
                // Start bot polling
                bot.start({
                    onStart: function (botInfo) {
                        logger_simple_js_1.telegramLogger.info({ username: botInfo.username }, 'Bot started successfully');
                    },
                });
                port = index_simple_js_1.config.server.port;
                host = index_simple_js_1.config.server.host;
                return [4 /*yield*/, app.listen({ port: port, host: host })];
            case 3:
                _a.sent();
                logger_simple_js_1.serverLogger.info({ port: port, host: host }, 'Server started');
                logger_simple_js_1.logger.info('✓ Amina Bot is ready!');
                return [3 /*break*/, 5];
            case 4:
                error_1 = _a.sent();
                logger_simple_js_1.logger.error({ error: error_1 }, 'Failed to start application');
                process.exit(1);
                return [3 /*break*/, 5];
            case 5: return [2 /*return*/];
        }
    });
}); };
// --------------------------------------------
// Graceful Shutdown
// --------------------------------------------
var shutdown = function (signal) { return __awaiter(void 0, void 0, void 0, function () {
    return __generator(this, function (_a) {
        switch (_a.label) {
            case 0:
                logger_simple_js_1.logger.info({ signal: signal }, 'Shutdown signal received');
                if (!bot) return [3 /*break*/, 2];
                logger_simple_js_1.logger.info('Stopping bot...');
                return [4 /*yield*/, bot.stop()];
            case 1:
                _a.sent();
                _a.label = 2;
            case 2:
                logger_simple_js_1.logger.info('Closing server...');
                return [4 /*yield*/, app.close()];
            case 3:
                _a.sent();
                logger_simple_js_1.logger.info('Shutdown complete');
                process.exit(0);
                return [2 /*return*/];
        }
    });
}); };
process.on('SIGTERM', function () { return shutdown('SIGTERM'); });
process.on('SIGINT', function () { return shutdown('SIGINT'); });
// Start the app
start();
