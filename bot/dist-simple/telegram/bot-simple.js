"use strict";
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
exports.createBot = void 0;
var grammy_1 = require("grammy");
var index_simple_js_1 = require("../config/index-simple.js");
var logger_simple_js_1 = require("../config/logger-simple.js");
var openrouter_simple_js_1 = require("../ai/openrouter-simple.js");
// --------------------------------------------
// Constants
// --------------------------------------------
var MAX_HISTORY_MESSAGES = 20;
var MAX_MESSAGE_LENGTH = 4096; // Telegram limit
// --------------------------------------------
// Create Bot Instance
// --------------------------------------------
var createBot = function () {
    var bot = new grammy_1.Bot(index_simple_js_1.config.telegram.token);
    // Session middleware
    bot.use((0, grammy_1.session)({
        initial: function () { return ({
            messageHistory: [],
        }); },
    }));
    // Error handler
    bot.catch(function (err) {
        var _a;
        logger_simple_js_1.telegramLogger.error({ error: err.error, ctx: (_a = err.ctx) === null || _a === void 0 ? void 0 : _a.update }, 'Bot error');
    });
    // Commands
    setupCommands(bot);
    // Message handlers
    setupMessageHandlers(bot);
    logger_simple_js_1.telegramLogger.info('Telegram bot configured');
    return bot;
};
exports.createBot = createBot;
// --------------------------------------------
// Command Handlers
// --------------------------------------------
var setupCommands = function (bot) {
    // /start - Welcome message
    bot.command('start', function (ctx) { return __awaiter(void 0, void 0, void 0, function () {
        var userId;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    userId = (_b = (_a = ctx.from) === null || _a === void 0 ? void 0 : _a.id.toString()) !== null && _b !== void 0 ? _b : 'unknown';
                    logger_simple_js_1.telegramLogger.info({ userId: userId }, 'User started bot');
                    return [4 /*yield*/, ctx.reply("\uD83D\uDC4B \u041F\u0440\u0438\u0432\u0435\u0442! \u042F Amina \u2014 \u0442\u0432\u043E\u0439 AI-\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043D\u0442.\n\n\u041F\u0440\u043E\u0441\u0442\u043E \u043D\u0430\u043F\u0438\u0448\u0438 \u043C\u043D\u0435 \u0441\u043E\u043E\u0431\u0449\u0435\u043D\u0438\u0435, \u0438 \u044F \u043F\u043E\u0441\u0442\u0430\u0440\u0430\u044E\u0441\u044C \u043F\u043E\u043C\u043E\u0447\u044C!\n\n\u041A\u043E\u043C\u0430\u043D\u0434\u044B:\n/help \u2014 \u043F\u043E\u043A\u0430\u0437\u0430\u0442\u044C \u0441\u043F\u0440\u0430\u0432\u043A\u0443\n/clear \u2014 \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0438\u0441\u0442\u043E\u0440\u0438\u044E \u0434\u0438\u0430\u043B\u043E\u0433\u0430")];
                case 1:
                    _c.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    // /help - Help message
    bot.command('help', function (ctx) { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, ctx.reply("\uD83E\uDD16 **Amina AI Bot**\n\n\u042F \u043C\u043E\u0433\u0443:\n\u2022 \u041E\u0442\u0432\u0435\u0447\u0430\u0442\u044C \u043D\u0430 \u0432\u043E\u043F\u0440\u043E\u0441\u044B\n\u2022 \u041F\u043E\u043C\u043E\u0433\u0430\u0442\u044C \u0441 \u0442\u0435\u043A\u0441\u0442\u0430\u043C\u0438\n\u2022 \u041F\u0435\u0440\u0435\u0432\u043E\u0434\u0438\u0442\u044C\n\u2022 \u041E\u0431\u044A\u044F\u0441\u043D\u044F\u0442\u044C \u0441\u043B\u043E\u0436\u043D\u044B\u0435 \u0442\u0435\u043C\u044B\n\u2022 \u041F\u043E\u0434\u0434\u0435\u0440\u0436\u0438\u0432\u0430\u0442\u044C \u0434\u0438\u0430\u043B\u043E\u0433 \u0441 \u043A\u043E\u043D\u0442\u0435\u043A\u0441\u0442\u043E\u043C\n\n**\u041A\u043E\u043C\u0430\u043D\u0434\u044B:**\n/start \u2014 \u043D\u0430\u0447\u0430\u0442\u044C \u0441\u043D\u0430\u0447\u0430\u043B\u0430\n/clear \u2014 \u043E\u0447\u0438\u0441\u0442\u0438\u0442\u044C \u0438\u0441\u0442\u043E\u0440\u0438\u044E \u0434\u0438\u0430\u043B\u043E\u0433\u0430\n\n**\u0421\u043E\u0432\u0435\u0442:** \u0427\u0435\u043C \u043A\u043E\u043D\u043A\u0440\u0435\u0442\u043D\u0435\u0435 \u0432\u043E\u043F\u0440\u043E\u0441, \u0442\u0435\u043C \u043B\u0443\u0447\u0448\u0435 \u043E\u0442\u0432\u0435\u0442!", { parse_mode: 'Markdown' })];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    // /clear - Clear conversation history
    bot.command('clear', function (ctx) { return __awaiter(void 0, void 0, void 0, function () {
        var _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    ctx.session.messageHistory = [];
                    logger_simple_js_1.telegramLogger.info({ userId: (_a = ctx.from) === null || _a === void 0 ? void 0 : _a.id }, 'Conversation cleared');
                    return [4 /*yield*/, ctx.reply('🧹 История диалога очищена. Начнём сначала!')];
                case 1:
                    _b.sent();
                    return [2 /*return*/];
            }
        });
    }); });
};
// --------------------------------------------
// Message Handlers
// --------------------------------------------
var setupMessageHandlers = function (bot) {
    // Text messages
    bot.on('message:text', function (ctx) { return __awaiter(void 0, void 0, void 0, function () {
        var userId, chatId, userMessage, response, error_1;
        var _a, _b;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    userId = (_b = (_a = ctx.from) === null || _a === void 0 ? void 0 : _a.id.toString()) !== null && _b !== void 0 ? _b : 'unknown';
                    chatId = ctx.chat.id;
                    userMessage = ctx.message.text;
                    logger_simple_js_1.telegramLogger.debug({ userId: userId, chatId: chatId, messageLength: userMessage.length }, 'Text message received');
                    // Show typing indicator
                    return [4 /*yield*/, ctx.replyWithChatAction('typing')];
                case 1:
                    // Show typing indicator
                    _c.sent();
                    _c.label = 2;
                case 2:
                    _c.trys.push([2, 5, , 7]);
                    // Add user message to history
                    ctx.session.messageHistory.push({
                        role: 'user',
                        content: userMessage,
                    });
                    // Trim history if too long
                    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
                        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
                    }
                    return [4 /*yield*/, openrouter_simple_js_1.aiService.chat(ctx.session.messageHistory)];
                case 3:
                    response = _c.sent();
                    // Add assistant response to history
                    ctx.session.messageHistory.push({
                        role: 'assistant',
                        content: response.content,
                    });
                    // Send response (split if too long)
                    return [4 /*yield*/, sendLongMessage(ctx, response.content)];
                case 4:
                    // Send response (split if too long)
                    _c.sent();
                    logger_simple_js_1.telegramLogger.info({ userId: userId, tokens: response.tokens_used.total }, 'Response sent');
                    return [3 /*break*/, 7];
                case 5:
                    error_1 = _c.sent();
                    logger_simple_js_1.telegramLogger.error({ error: error_1, userId: userId }, 'Failed to process message');
                    return [4 /*yield*/, ctx.reply('😔 Извини, произошла ошибка. Попробуй ещё раз или напиши /clear для сброса диалога.')];
                case 6:
                    _c.sent();
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    }); });
    // Voice messages
    bot.on('message:voice', function (ctx) { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, ctx.reply('🎤 Голосовые сообщения временно недоступны.\n\nОтправьте текстовое сообщение.')];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    }); });
    // Stickers and other media
    bot.on('message', function (ctx) { return __awaiter(void 0, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    if (!(!ctx.message.text && !ctx.message.voice)) return [3 /*break*/, 2];
                    return [4 /*yield*/, ctx.reply('🤔 Пока что я понимаю только текстовые сообщения.')];
                case 1:
                    _a.sent();
                    _a.label = 2;
                case 2: return [2 /*return*/];
            }
        });
    }); });
};
// --------------------------------------------
// Utility Functions
// --------------------------------------------
var sendLongMessage = function (ctx, text) { return __awaiter(void 0, void 0, void 0, function () {
    var chunks, currentChunk, paragraphs, _i, paragraphs_1, paragraph, sentences, _a, sentences_1, sentence, _b, chunks_1, chunk;
    return __generator(this, function (_c) {
        switch (_c.label) {
            case 0:
                if (!(text.length <= MAX_MESSAGE_LENGTH)) return [3 /*break*/, 2];
                return [4 /*yield*/, ctx.reply(text)];
            case 1:
                _c.sent();
                return [2 /*return*/];
            case 2:
                chunks = [];
                currentChunk = '';
                paragraphs = text.split('\n\n');
                for (_i = 0, paragraphs_1 = paragraphs; _i < paragraphs_1.length; _i++) {
                    paragraph = paragraphs_1[_i];
                    if (currentChunk.length + paragraph.length + 2 > MAX_MESSAGE_LENGTH) {
                        if (currentChunk) {
                            chunks.push(currentChunk.trim());
                            currentChunk = '';
                        }
                        // If single paragraph is too long, split by sentences
                        if (paragraph.length > MAX_MESSAGE_LENGTH) {
                            sentences = paragraph.split(/(?<=[.!?])\s+/);
                            for (_a = 0, sentences_1 = sentences; _a < sentences_1.length; _a++) {
                                sentence = sentences_1[_a];
                                if (currentChunk.length + sentence.length + 1 > MAX_MESSAGE_LENGTH) {
                                    if (currentChunk)
                                        chunks.push(currentChunk.trim());
                                    currentChunk = sentence;
                                }
                                else {
                                    currentChunk += (currentChunk ? ' ' : '') + sentence;
                                }
                            }
                        }
                        else {
                            currentChunk = paragraph;
                        }
                    }
                    else {
                        currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
                    }
                }
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                }
                _b = 0, chunks_1 = chunks;
                _c.label = 3;
            case 3:
                if (!(_b < chunks_1.length)) return [3 /*break*/, 6];
                chunk = chunks_1[_b];
                return [4 /*yield*/, ctx.reply(chunk)];
            case 4:
                _c.sent();
                _c.label = 5;
            case 5:
                _b++;
                return [3 /*break*/, 3];
            case 6: return [2 /*return*/];
        }
    });
}); };
