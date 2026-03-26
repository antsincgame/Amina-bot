/**
 * ESL (Event Socket Library) — обёртка для управления FreeSWITCH
 *
 * Подписывается на события звонков, позволяет:
 * - Отвечать/класть трубку
 * - Проигрывать аудио
 * - Отслеживать статус каналов
 */

import { EventEmitter } from 'node:events';
import { log } from './logger.js';

// modesl — Node.js ESL клиент для FreeSWITCH
// @ts-expect-error — modesl не имеет типов
import esl from 'modesl';

export interface EslEvent {
  uuid: string;
  callerNumber: string;
  destinationNumber: string;
  hangupCause?: string;
  raw: Record<string, string>;
}

interface EslConnectionEvents {
  channel_answer: (event: EslEvent) => void;
  channel_hangup: (event: EslEvent) => void;
  channel_create: (event: EslEvent) => void;
  connected: () => void;
  disconnected: () => void;
}

export class EslConnection extends EventEmitter {
  private host: string;
  private port: number;
  private password: string;
  private conn: InstanceType<typeof esl.Connection> | null = null;
  private connected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private readonly MAX_RECONNECT_DELAY = 30_000;

  constructor(host: string, port: number, password: string) {
    super();
    this.host = host;
    this.port = port;
    this.password = password;
  }

  on<K extends keyof EslConnectionEvents>(event: K, listener: EslConnectionEvents[K]): this {
    return super.on(event, listener);
  }

  emit<K extends keyof EslConnectionEvents>(event: K, ...args: Parameters<EslConnectionEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  isConnected(): boolean {
    return this.connected;
  }

  connect(): void {
    if (this.conn) {
      try { this.conn.disconnect(); } catch { /* игнорируем */ }
    }

    log.info(`[ESL] Подключение к ${this.host}:${this.port}...`);

    try {
      this.conn = new esl.Connection(this.host, this.port, this.password, () => {
        this.connected = true;
        this.reconnectAttempts = 0;
        log.info('[ESL] ✅ Подключено к FreeSWITCH');
        this.emit('connected');

        // Подписка на события звонков
        this.conn!.subscribe(['CHANNEL_CREATE', 'CHANNEL_ANSWER', 'CHANNEL_HANGUP_COMPLETE'], () => {
          log.info('[ESL] Подписка на события активна');
        });

        this.conn!.on('esl::event::CHANNEL_CREATE::*', (evt: { getHeader: (name: string) => string }) => {
          this.handleEvent('channel_create', evt);
        });

        this.conn!.on('esl::event::CHANNEL_ANSWER::*', (evt: { getHeader: (name: string) => string }) => {
          this.handleEvent('channel_answer', evt);
        });

        this.conn!.on('esl::event::CHANNEL_HANGUP_COMPLETE::*', (evt: { getHeader: (name: string) => string }) => {
          this.handleEvent('channel_hangup', evt);
        });

        this.conn!.on('error', (err: Error) => {
          log.error(`[ESL] Ошибка: ${err.message}`);
        });

        this.conn!.on('esl::end', () => {
          this.connected = false;
          log.warn('[ESL] Соединение разорвано');
          this.emit('disconnected');
          this.scheduleReconnect();
        });
      });
    } catch (error) {
      log.error(`[ESL] Ошибка подключения: ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.conn) {
      try { this.conn.disconnect(); } catch { /* игнорируем */ }
      this.conn = null;
    }
    this.connected = false;
  }

  /** Завершить звонок по UUID */
  async hangup(uuid: string, cause = 'NORMAL_CLEARING'): Promise<void> {
    if (!this.conn || !this.connected) {
      throw new Error('ESL не подключён');
    }
    return new Promise((resolve, reject) => {
      this.conn!.api(`uuid_kill ${uuid} ${cause}`, (res: { body: string }) => {
        if (res.body?.startsWith('-ERR')) {
          reject(new Error(res.body));
        } else {
          log.info(`[ESL] Hangup uuid=${uuid} cause=${cause}`);
          resolve();
        }
      });
    });
  }

  /** Проиграть аудио файл в канале */
  async playback(uuid: string, filePath: string): Promise<void> {
    if (!this.conn || !this.connected) {
      throw new Error('ESL не подключён');
    }
    return new Promise((resolve, reject) => {
      this.conn!.api(`uuid_broadcast ${uuid} ${filePath} both`, (res: { body: string }) => {
        if (res.body?.startsWith('-ERR')) {
          reject(new Error(res.body));
        } else {
          log.info(`[ESL] Playback uuid=${uuid} file=${filePath}`);
          resolve();
        }
      });
    });
  }

  /** Выполнить произвольную API команду FreeSWITCH */
  async api(command: string): Promise<string> {
    if (!this.conn || !this.connected) {
      throw new Error('ESL не подключён');
    }
    return new Promise((resolve, reject) => {
      this.conn!.api(command, (res: { body: string }) => {
        if (res.body?.startsWith('-ERR')) {
          reject(new Error(res.body));
        } else {
          resolve(res.body || '');
        }
      });
    });
  }

  /** Получить статус FreeSWITCH */
  async status(): Promise<string> {
    return this.api('status');
  }

  /** Получить список SIP-регистраций */
  async sofiaStatus(): Promise<string> {
    return this.api('sofia status');
  }

  /** Получить статус шлюза LiraX */
  async gatewayStatus(): Promise<string> {
    return this.api('sofia status gateway lirax');
  }

  // ── Внутренние методы ──

  private handleEvent(type: string, evt: { getHeader: (name: string) => string }): void {
    const parsed: EslEvent = {
      uuid: evt.getHeader('Unique-ID') || '',
      callerNumber: evt.getHeader('Caller-Caller-ID-Number') || '',
      destinationNumber: evt.getHeader('Caller-Destination-Number') || '',
      hangupCause: evt.getHeader('Hangup-Cause') || undefined,
      raw: {},
    };

    super.emit(type, parsed);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectAttempts++;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.MAX_RECONNECT_DELAY,
    );

    log.info(`[ESL] Переподключение через ${(delay / 1000).toFixed(0)}с (попытка ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
