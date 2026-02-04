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
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.aiService = void 0;
var openai_1 = require("openai");
var index_simple_js_1 = require("../config/index-simple.js");
var logger_simple_js_1 = require("../config/logger-simple.js");
var openai = null;
var getClient = function () {
    if (!openai) {
        openai = new openai_1.default({
            apiKey: index_simple_js_1.config.ai.apiKey,
            baseURL: index_simple_js_1.config.ai.baseUrl,
            defaultHeaders: {
                'HTTP-Referer': 'https://amina-bot.render.com',
                'X-Title': 'Amina AI Bot',
            },
        });
        logger_simple_js_1.aiLogger.info('OpenRouter client initialized');
    }
    return openai;
};
var getDefaultSystemPrompt = function () {
    return "\u0422\u044B \u2014 Amina, \u0434\u0440\u0443\u0436\u0435\u043B\u044E\u0431\u043D\u044B\u0439 AI-\u0430\u0441\u0441\u0438\u0441\u0442\u0435\u043D\u0442. \n  \n\u0422\u0432\u043E\u0438 \u043A\u0430\u0447\u0435\u0441\u0442\u0432\u0430:\n- \u041E\u0442\u0432\u0435\u0447\u0430\u0435\u0448\u044C \u043A\u0440\u0430\u0442\u043A\u043E \u0438 \u043F\u043E \u0434\u0435\u043B\u0443\n- \u0418\u0441\u043F\u043E\u043B\u044C\u0437\u0443\u0435\u0448\u044C \u043F\u043E\u043D\u044F\u0442\u043D\u044B\u0439 \u044F\u0437\u044B\u043A\n- \u041F\u043E\u043C\u043E\u0433\u0430\u0435\u0448\u044C \u0440\u0435\u0448\u0430\u0442\u044C \u0437\u0430\u0434\u0430\u0447\u0438 \u043F\u043E\u043B\u044C\u0437\u043E\u0432\u0430\u0442\u0435\u043B\u044F\n- \u0415\u0441\u043B\u0438 \u043D\u0435 \u0437\u043D\u0430\u0435\u0448\u044C \u043E\u0442\u0432\u0435\u0442 \u2014 \u0447\u0435\u0441\u0442\u043D\u043E \u0433\u043E\u0432\u043E\u0440\u0438\u0448\u044C \u043E\u0431 \u044D\u0442\u043E\u043C\n\n\u041E\u0442\u0432\u0435\u0447\u0430\u0439 \u043D\u0430 \u0442\u043E\u043C \u044F\u0437\u044B\u043A\u0435, \u043D\u0430 \u043A\u043E\u0442\u043E\u0440\u043E\u043C \u043A \u0442\u0435\u0431\u0435 \u043E\u0431\u0440\u0430\u0449\u0430\u044E\u0442\u0441\u044F.";
};
// --------------------------------------------
// AI Service
// --------------------------------------------
exports.aiService = {
    /**
     * Generate AI response for messages
     */
    chat: function (messages) {
        return __awaiter(this, void 0, void 0, function () {
            var client, fullMessages, response, choice, result, error_1;
            var _a, _b, _c, _d, _e, _f, _g, _h, _j;
            return __generator(this, function (_k) {
                switch (_k.label) {
                    case 0:
                        client = getClient();
                        fullMessages = ((_a = messages[0]) === null || _a === void 0 ? void 0 : _a.role) === 'system'
                            ? messages
                            : __spreadArray([{ role: 'system', content: getDefaultSystemPrompt() }], messages, true);
                        logger_simple_js_1.aiLogger.debug({ model: index_simple_js_1.config.ai.model, messageCount: messages.length }, 'Sending chat request');
                        _k.label = 1;
                    case 1:
                        _k.trys.push([1, 3, , 4]);
                        return [4 /*yield*/, client.chat.completions.create({
                                model: index_simple_js_1.config.ai.model,
                                messages: fullMessages,
                                max_tokens: index_simple_js_1.config.ai.maxTokens,
                                temperature: index_simple_js_1.config.ai.temperature,
                            })];
                    case 2:
                        response = _k.sent();
                        choice = response.choices[0];
                        if (!((_b = choice === null || choice === void 0 ? void 0 : choice.message) === null || _b === void 0 ? void 0 : _b.content)) {
                            throw new Error('Empty response from AI');
                        }
                        result = {
                            content: choice.message.content,
                            model: response.model,
                            tokens_used: {
                                prompt: (_d = (_c = response.usage) === null || _c === void 0 ? void 0 : _c.prompt_tokens) !== null && _d !== void 0 ? _d : 0,
                                completion: (_f = (_e = response.usage) === null || _e === void 0 ? void 0 : _e.completion_tokens) !== null && _f !== void 0 ? _f : 0,
                                total: (_h = (_g = response.usage) === null || _g === void 0 ? void 0 : _g.total_tokens) !== null && _h !== void 0 ? _h : 0,
                            },
                            finish_reason: (_j = choice.finish_reason) !== null && _j !== void 0 ? _j : 'unknown',
                        };
                        logger_simple_js_1.aiLogger.info({ model: result.model, tokens: result.tokens_used.total }, 'AI response received');
                        return [2 /*return*/, result];
                    case 3:
                        error_1 = _k.sent();
                        logger_simple_js_1.aiLogger.error({ error: error_1 }, 'AI request failed');
                        throw error_1;
                    case 4: return [2 /*return*/];
                }
            });
        });
    },
    /**
     * Simple single-message response
     */
    complete: function (userMessage) {
        return __awaiter(this, void 0, void 0, function () {
            var response;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0: return [4 /*yield*/, this.chat([{ role: 'user', content: userMessage }])];
                    case 1:
                        response = _a.sent();
                        return [2 /*return*/, response.content];
                }
            });
        });
    },
    /**
     * Test AI connection
     */
    testConnection: function () {
        return __awaiter(this, void 0, void 0, function () {
            var response, _a;
            return __generator(this, function (_b) {
                switch (_b.label) {
                    case 0:
                        _b.trys.push([0, 2, , 3]);
                        return [4 /*yield*/, this.complete('Say "OK" if you can hear me.')];
                    case 1:
                        response = _b.sent();
                        return [2 /*return*/, response.toLowerCase().includes('ok')];
                    case 2:
                        _a = _b.sent();
                        return [2 /*return*/, false];
                    case 3: return [2 /*return*/];
                }
            });
        });
    },
};
