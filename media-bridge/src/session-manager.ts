/**
 * Менеджер сессий медиа-моста
 *
 * Отслеживает активные звонки:
 *   Amina sessionId ↔ FreeSWITCH UUID ↔ WebSocket
 */

import { randomUUID } from 'node:crypto';
import { log } from './logger.js';

export interface BridgeSession {
  /** Внутренний ID сессии моста */
  id: string;
  /** ID сессии в Amina */
  sessionId: string;
  /** Номер абонента */
  phone: string;
  /** Задача */
  task: string;
  /** FreeSWITCH UUID канала */
  fsUuid: string | null;
  /** WebSocket подключён */
  wsConnected: boolean;
  /** Статус */
  status: 'pending' | 'dialing' | 'active' | 'completed';
  /** Причина завершения */
  completionReason: string | null;
  /** Callback URLs в Amina */
  callbacks: {
    eventsUrl: string;
    respondUrl: string;
    bootstrapOnConnect?: boolean;
  } | null;
  /** Голосовой провайдер */
  voice: Record<string, unknown> | null;
  /** STT профиль */
  speech: Record<string, unknown> | null;
  /** Телефония (SIP + AI) */
  telephony: Record<string, unknown> | null;
  /** Бюджет задержки */
  latencyBudgetMs: number;
  /** Сценарий */
  scenario: Record<string, unknown> | null;
  /** План звонка */
  plan: Record<string, unknown> | null;
  /** Начальный текст агента */
  initialAgentText: string;
  /** Метки времени */
  createdAt: number;
  connectedAt: number | null;
  completedAt: number | null;
}

export interface CreateSessionInput {
  sessionId: string;
  phone: string;
  task: string;
  scenario?: Record<string, unknown>;
  plan?: Record<string, unknown>;
  initialAgentText?: string;
  callbacks?: {
    eventsUrl: string;
    respondUrl: string;
    bootstrapOnConnect?: boolean;
  };
  voice?: Record<string, unknown>;
  speech?: Record<string, unknown>;
  telephony?: Record<string, unknown>;
  latencyBudgetMs?: number;
}

export class SessionManager {
  private sessions = new Map<string, BridgeSession>();

  /** Создать новую сессию */
  create(input: CreateSessionInput): BridgeSession {
    const id = randomUUID().slice(0, 12);

    const session: BridgeSession = {
      id,
      sessionId: input.sessionId,
      phone: input.phone,
      task: input.task,
      fsUuid: null,
      wsConnected: false,
      status: 'pending',
      completionReason: null,
      callbacks: input.callbacks || null,
      voice: input.voice || null,
      speech: input.speech || null,
      telephony: input.telephony || null,
      latencyBudgetMs: input.latencyBudgetMs ?? 1800,
      scenario: input.scenario || null,
      plan: input.plan || null,
      initialAgentText: input.initialAgentText || '',
      createdAt: Date.now(),
      connectedAt: null,
      completedAt: null,
    };

    this.sessions.set(id, session);

    // Автоочистка через 10 минут для застрявших сессий
    setTimeout(() => {
      const s = this.sessions.get(id);
      if (s && s.status !== 'completed') {
        log.warn(`[Session] Автоочистка зависшей сессии: ${id}`);
        this.complete(id, 'timeout');
      }
    }, 10 * 60 * 1000);

    return session;
  }

  /** Получить сессию по ID моста */
  get(id: string): BridgeSession | undefined {
    return this.sessions.get(id);
  }

  /** Найти сессию по FreeSWITCH UUID */
  findByFsUuid(uuid: string): BridgeSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.fsUuid === uuid && s.status !== 'completed') return s;
    }
    return undefined;
  }

  /** Найти сессию по номеру телефона (для привязки входящего звонка) */
  findByPhone(phone: string): BridgeSession | undefined {
    const normalized = phone.replace(/[^\d+]/g, '');
    for (const s of this.sessions.values()) {
      if (s.status !== 'completed' && s.phone.replace(/[^\d+]/g, '').endsWith(normalized.slice(-7))) {
        return s;
      }
    }
    return undefined;
  }

  /** Найти сессию по Amina sessionId */
  findByAminaSessionId(aminaSessionId: string): BridgeSession | undefined {
    for (const s of this.sessions.values()) {
      if (s.sessionId === aminaSessionId) return s;
    }
    return undefined;
  }

  /** Завершить сессию */
  complete(id: string, reason: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.status = 'completed';
    session.completionReason = reason;
    session.completedAt = Date.now();

    const duration = session.connectedAt
      ? ((session.completedAt - session.connectedAt) / 1000).toFixed(1)
      : '0';

    log.info(`[Session] Завершена: ${id} → ${reason} (${duration}с)`);

    // Удаляем из карты через 60с (для запоздалых запросов)
    setTimeout(() => this.sessions.delete(id), 60_000);
  }

  /** Количество активных сессий */
  count(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.status !== 'completed') n++;
    }
    return n;
  }

  /** Список всех сессий (для дебага) */
  list(): BridgeSession[] {
    return [...this.sessions.values()];
  }
}
