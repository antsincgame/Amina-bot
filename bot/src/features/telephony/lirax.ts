/**
 * LiraX Telephony Integration
 *
 * Двусторонняя интеграция с АТС LiraX:
 *  - Bot → LiraX: makeCall, make2Calls, getCallHistory, getUsers
 *  - LiraX → Bot: вебхуки event, record, contact, staton
 *
 * Документация: https://api.lirax.net/general
 */

import { telegramLogger } from '../../config/logger.js';
import { settingsRepo } from '../../db/index.js';
import { LIRAX_FETCH_TIMEOUT_MS } from '../../config/constants.js';
import { getTelephonyRuntimeConfig, clearTelephonyRuntimeConfigCache } from './service/telephony-runtime-config.js';

// ---------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------

export interface LiraXConfig {
  url: string;
  token: string;
  webhookToken: string;
  defaultExt: string;
  operatorPhone: string;
}

let configCache: LiraXConfig | null = null;

export async function getLiraXConfig(): Promise<LiraXConfig> {
  if (configCache) return configCache;

  const runtimeConfig = await getTelephonyRuntimeConfig();

  configCache = {
    url: runtimeConfig.liraxUrl,
    token: runtimeConfig.liraxToken,
    webhookToken: runtimeConfig.liraxWebhookToken,
    defaultExt: runtimeConfig.liraxDefaultExt,
    operatorPhone: runtimeConfig.operatorPhone,
  };
  return configCache;
}

export function clearLiraXConfigCache(): void {
  configCache = null;
  clearTelephonyRuntimeConfigCache();
}

// ---------------------------------------------------------------
// Low-level request helper
// ---------------------------------------------------------------

async function liraXRequest(
  cmd: string,
  params: Record<string, string | number>,
): Promise<unknown> {
  const cfg = await getLiraXConfig();

  if (!cfg.token) {
    throw new Error('LiraX не настроен: отсутствует LIRAX_TOKEN');
  }

  const body = new URLSearchParams();
  body.set('cmd', cmd);
  body.set('token', cfg.token);

  for (const [key, value] of Object.entries(params)) {
    body.set(key, String(value));
  }

  const { token: _redacted, ...safeParams } = Object.fromEntries(body);
  telegramLogger.info({ cmd, params: safeParams }, '[LiraX] → request');

  let response: Response;
  try {
    response = await fetch(cfg.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(LIRAX_FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`LiraX API timeout after ${LIRAX_FETCH_TIMEOUT_MS}ms`);
    }

    throw error;
  }

  const text = await response.text();

  if (!response.ok) {
    const detail =
      response.status === 401
        ? 'Неверный token'
        : response.status === 400
          ? 'Некорректные параметры'
          : text;
    throw new Error(`LiraX API error ${response.status}: ${detail}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------
// Public API — Bot → LiraX
// ---------------------------------------------------------------

export interface MakeCallResult {
  id_makecall: string;
}

/**
 * Инициировать звонок: сначала звонит менеджеру (from/ext), потом соединяет с клиентом.
 */
export async function makeCall(
  to: string,
  fromExt?: string,
): Promise<MakeCallResult> {
  const cfg = await getLiraXConfig();
  const ext = fromExt || cfg.defaultExt;

  const result = await liraXRequest('makeCall', { from: ext, to });
  return result as MakeCallResult;
}

export interface Make2CallsResult {
  id_make2calls: string;
}

/**
 * Соединить двух абонентов с опциональным голосовым сообщением (TTS).
 */
export async function make2Calls(params: {
  to1: string;
  to2: string;
  fromExt?: string;
  speech?: string;
  timeout?: number;
}): Promise<Make2CallsResult> {
  const cfg = await getLiraXConfig();
  const body: Record<string, string | number> = {
    from: params.fromExt || cfg.defaultExt,
    to1: params.to1,
    to2: params.to2,
  };
  if (params.speech) body['speech'] = params.speech;
  if (params.timeout) body['timeout'] = params.timeout;

  const result = await liraXRequest('make2Calls', body);
  return result as Make2CallsResult;
}

export interface AskQuestionResult {
  id: string;
  mode: 'ask_question';
  raw: unknown;
}

/**
 * Позвонить абоненту с автоматическим вопросом и дождаться ответа.
 */
export async function askQuestion(params: {
  to: string;
  fromExt?: string;
  hello?: string;
  ask: string;
  ok?: string;
  bye?: string;
  timeout?: number;
  successTime?: number;
}): Promise<AskQuestionResult> {
  const cfg = await getLiraXConfig();
  const body: Record<string, string | number> = {
    from: params.fromExt || cfg.defaultExt,
    to1: params.to,
    ask: params.ask,
  };

  if (params.hello) body['hello'] = params.hello;
  if (params.ok) body['ok'] = params.ok;
  if (params.bye) body['bye'] = params.bye;
  if (params.timeout) body['timeout'] = params.timeout;
  if (params.successTime) body['successtime'] = params.successTime;

  const result = await liraXRequest('AskQuestion', body);
  const payload = typeof result === 'object' && result !== null
    ? result as Record<string, unknown>
    : null;

  const id = typeof payload?.['id_make2calls'] === 'string'
    ? payload['id_make2calls']
    : typeof payload?.['id_askquestion'] === 'string'
      ? payload['id_askquestion']
    : typeof payload?.['id_makecall'] === 'string'
      ? payload['id_makecall']
      : typeof payload?.['id'] === 'string'
        ? payload['id']
        : '';

  return {
    id,
    mode: 'ask_question',
    raw: result,
  };
}

export interface ConnectCallResult {
  id: string;
  mode: 'make2calls' | 'makecall';
}

/**
 * Умный звонок: если задан operatorPhone — make2Calls (мобильный→мобильный),
 * иначе fallback на makeCall (SIP ext → мобильный).
 */
export async function connectCall(
  targetPhone: string,
  speech?: string,
): Promise<ConnectCallResult> {
  const cfg = await getLiraXConfig();

  if (cfg.operatorPhone) {
    const params: Record<string, string | number> = {
      from: cfg.defaultExt,
      to1: cfg.operatorPhone,
      to2: targetPhone,
    };
    if (speech) params['speech'] = `ru ${speech}`;

    const result = await liraXRequest('make2Calls', params) as Make2CallsResult;
    return { id: result.id_make2calls, mode: 'make2calls' };
  }

  const result = await liraXRequest('makeCall', {
    from: cfg.defaultExt,
    to: targetPhone,
  }) as MakeCallResult;
  return { id: result.id_makecall, mode: 'makecall' };
}

export interface CallRecord {
  call_id: string;
  ani: string;
  dnis: string;
  start: string;
  connect: string;
  record: string;
  type: string;
  duration: string;
  disconnect_side: string;
}

/**
 * Получить историю звонков за диапазон дат (максимум 48 часов).
 */
export async function getCallHistory(
  dateStart: string,
  dateFinish: string,
  callType?: 0 | 1 | -1,
): Promise<CallRecord[]> {
  const params: Record<string, string | number> = {
    date_start: dateStart,
    date_finish: dateFinish,
  };
  if (callType !== undefined) params['call_type'] = callType;

  const result = await liraXRequest('get_calls', params);
  return (Array.isArray(result) ? result : []) as CallRecord[];
}

export interface LiraXUser {
  id: string;
  Name: string;
  ext: string;
  active: '0' | '1';
}

/**
 * Получить список сотрудников/операторов.
 */
export async function getUsers(): Promise<LiraXUser[]> {
  const result = await liraXRequest('getUsers', {}) as { users: LiraXUser[] };
  return result.users ?? [];
}

/**
 * Получить данные о звонке по id_makecall.
 */
export interface MakeCallData {
  id_makecall: string;
  call_start: string;
  call_record: string;
  duration: string;
}

export async function getMakeCallData(idMakecall: string): Promise<MakeCallData> {
  const result = await liraXRequest('get_makecall_data', { id_makecall: idMakecall });
  return result as MakeCallData;
}

// ---------------------------------------------------------------
// Webhook payload types — LiraX → Bot
// ---------------------------------------------------------------

export type LiraXWebhookCmd =
  | 'event'
  | 'record'
  | 'contact'
  | 'staton'
  | 'makecall_finished'
  | 'make2calls_finished'
  | 'smsDelivered'
  | 'smsReceived';

export interface LiraXEventPayload {
  cmd: 'event';
  type: 'in' | 'out';
  event: 'INCOMING' | 'ACCEPTED' | 'COMPLETED' | 'CALL_COMPLETED';
  phone: string;
  ext: string;
  callid: string;
  diversion?: string;
  duration?: string;
  call_duration?: string;
  is_recorded?: string;
  status?: string;
  record_link?: string;
  from_LiraX_token: string;
}

export interface LiraXRecordPayload {
  cmd: 'record';
  callid: string;
  record_link: string;
  from_LiraX_token: string;
}

export interface LiraXContactPayload {
  cmd: 'contact';
  phone: string;
  callid: string;
  diversion?: string;
  from_LiraX_token: string;
}

export interface LiraXStatonPayload {
  cmd: 'staton';
  ext: string;
  status: string;
  from_LiraX_token: string;
}

export interface LiraXMakeCallFinishedPayload {
  cmd: 'makecall_finished';
  id_makecall: string;
  Call_id: string;
  success: string;
  from_LiraX_token: string;
}

export type LiraXWebhookPayload =
  | LiraXEventPayload
  | LiraXRecordPayload
  | LiraXContactPayload
  | LiraXStatonPayload
  | LiraXMakeCallFinishedPayload
  | Record<string, string>;

// ---------------------------------------------------------------
// Telephony user permissions
// ---------------------------------------------------------------

export interface TelephonyUser {
  telegram_id: string;
  name: string;
  added_at: string;
}

const TELEPHONY_USERS_KEY = 'telephony_allowed_users';

export async function getTelephonyUsers(): Promise<TelephonyUser[]> {
  const raw = await settingsRepo.get(TELEPHONY_USERS_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TelephonyUser[];
  } catch {
    return [];
  }
}

export async function addTelephonyUser(telegramId: string, name: string): Promise<TelephonyUser[]> {
  const users = await getTelephonyUsers();
  const exists = users.some((u) => u.telegram_id === telegramId);
  if (exists) return users;

  const updated = [
    ...users,
    { telegram_id: telegramId, name, added_at: new Date().toISOString() },
  ];
  await settingsRepo.set(TELEPHONY_USERS_KEY, JSON.stringify(updated));
  return updated;
}

export async function removeTelephonyUser(telegramId: string): Promise<TelephonyUser[]> {
  const users = await getTelephonyUsers();
  const updated = users.filter((u) => u.telegram_id !== telegramId);
  await settingsRepo.set(TELEPHONY_USERS_KEY, JSON.stringify(updated));
  return updated;
}

export async function isTelephonyAllowed(telegramId: string): Promise<boolean> {
  const [liraxAdminId, globalAdminId] = await Promise.all([
    settingsRepo.get('lirax_admin_chat_id'),
    settingsRepo.get('admin_chat_id'),
  ]);
  if (liraxAdminId && liraxAdminId === telegramId) return true;
  if (globalAdminId && globalAdminId === telegramId) return true;

  const users = await getTelephonyUsers();
  return users.some((u) => u.telegram_id === telegramId);
}

// ---------------------------------------------------------------
// Webhook token verification
// ---------------------------------------------------------------

export async function verifyWebhookToken(token: string): Promise<boolean> {
  const cfg = await getLiraXConfig();
  if (!cfg.webhookToken) return true; // если не настроен — пропускаем
  return token === cfg.webhookToken;
}

// ---------------------------------------------------------------
// Human-readable event formatting (for Telegram notifications)
// ---------------------------------------------------------------

export function formatCallEvent(payload: LiraXEventPayload): string {
  const typeLabel = payload.type === 'in' ? '📲 Входящий' : '📞 Исходящий';
  const phone = payload.phone || '—';
  const ext = payload.ext || '—';

  switch (payload.event) {
    case 'INCOMING':
      return `${typeLabel} звонок\n📱 Номер: <code>${phone}</code>\n👤 Оператор: ${ext}`;

    case 'ACCEPTED':
      return `✅ Звонок принят\n📱 Номер: <code>${phone}</code>\n👤 Оператор: ${ext}`;

    case 'COMPLETED': {
      const dur = payload.duration ? `\n⏱ Длительность: ${payload.duration}с` : '';
      const status = payload.status ? `\n📊 Статус: ${payload.status}` : '';
      const rec = payload.record_link
        ? `\n🎙 <a href="${payload.record_link}">Слушать запись</a>`
        : '';
      return `${typeLabel} звонок завершён\n📱 Номер: <code>${phone}</code>\n👤 Оператор: ${ext}${dur}${status}${rec}`;
    }

    case 'CALL_COMPLETED': {
      const dur = payload.duration ? `\n⏱ Разговор: ${payload.duration}с` : '';
      const rec = payload.record_link
        ? `\n🎙 <a href="${payload.record_link}">Слушать запись</a>`
        : '';
      return `📵 Звонок полностью завершён\n📱 Номер: <code>${phone}</code>${dur}${rec}`;
    }

    default:
      return `📞 Событие звонка: ${payload.event}\n📱 ${phone}`;
  }
}
