# Amina Media Bridge

Медиа-мост для AI-телефонии: FreeSWITCH ↔ WebSocket ↔ AI Pipeline.

## Архитектура

```
LiraX make2Calls
  ├─ to1: телефон абонента
  └─ to2: SIP URI → FreeSWITCH
                      ↓
              mod_audio_fork
              аудио ↔ WebSocket
                      ↓
              Bridge сервер (Node.js)
              ├─ VAD → Whisper STT
              ├─ Amina AI (respond callback)
              └─ ElevenLabs TTS → аудио обратно
```

## Развёртывание на VPS

```bash
cd /root
git clone <repo> Amina-bot
cd Amina-bot/media-bridge

# 1. Настрой SIP пароль
cp .env.example .env
nano config/freeswitch/vars.xml  # подставь lirax_sip_password

# 2. Запусти
docker compose up -d

# 3. Проверь
curl http://localhost:3100/health
docker exec amina-freeswitch fs_cli -x "sofia status"
docker exec amina-freeswitch fs_cli -x "sofia status gateway lirax"
```

## Порты

| Порт | Протокол | Назначение |
|------|----------|------------|
| 5060 | UDP/TCP | SIP (внутренний) |
| 5080 | UDP/TCP | SIP (внешний, LiraX) |
| 3100 | TCP | Bridge API + WebSocket |
| 8022 | TCP | ESL (только localhost) |
| 16384-16484 | UDP | RTP медиа |

## API

- `GET /health` — статус моста
- `POST /` — создать сессию (Authorization: Bearer TOKEN)
- `GET /sessions` — список активных сессий
- `GET /session/:id` — статус сессии
- `POST /session/:id/hangup` — завершить звонок

## Фазы разработки

- [x] Фаза 1: Docker + FreeSWITCH + SIP регистрация в LiraX + Bridge каркас
- [ ] Фаза 2: Тест SIP звонка через make2Calls → FreeSWITCH отвечает
- [ ] Фаза 3: WebSocket аудио-стрим + VAD + Whisper STT
- [ ] Фаза 4: AI pipeline + ElevenLabs TTS + обратный аудио-поток
- [ ] Фаза 5: Barge-in, логирование, отчёты
