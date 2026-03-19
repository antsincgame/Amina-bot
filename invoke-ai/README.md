# InvokeAI для Амины — свой GPU-сервер + доступ с ПК

Здесь всё, чтобы **не зависеть от «магического доступа агента»**: вы поднимаете Invoke на **вашем** Linux-сервере с NVIDIA, проверяете окружение скриптом и открываете UI **с Windows** через SSH-туннель (или HTTPS через reverse proxy).

Официальная документация Docker: [Installing with Docker — InvokeAI](https://invoke-ai.github.io/InvokeAI/installation/040_INSTALL_DOCKER/).

## Что нужно

- Виртуальный или физический **Linux x86_64** (Ubuntu 22.04/24.04 — типовой вариант).
- **NVIDIA GPU** + драйвер + **[NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html)**.
- **Docker Engine** и плагин **`docker compose`** (V2).
- Сетевой доступ: **SSH** с вашей рабочей машины на сервер (ключи Ed25519 предпочтительны).

## 1. Подготовка на сервере

```bash
# Клон/обновление репозитория Amina-bot, затем:
cd invoke-ai
cp env.example .env
sudo mkdir -p /var/lib/invokeai
sudo chown -R "$USER:$USER" /var/lib/invokeai
```

Отредактируйте `.env`:

- `HOST_INVOKEAI_ROOT` — каталог данных (пример: `/var/lib/invokeai`).
- `HUGGINGFACE_TOKEN` — [токен HF](https://huggingface.co/settings/tokens) для загрузки моделей из Invoke.

Проверка железа и Docker:

```bash
chmod +x scripts/check-gpu-host.sh
./scripts/check-gpu-host.sh
```

Запуск:

```bash
docker compose pull
docker compose up -d
docker compose logs -f
```

Веб-интерфейс на сервере: `http://127.0.0.1:9090` (если порт по умолчанию). Наружу **по умолчанию не выставляйте** без TLS и авторизации.

## 2. Доступ с Windows (SSH-туннель) — «исправляем отсутствие доступа»

На рабочем ПК должен быть **OpenSSH Client** (в Windows 10/11 обычно уже есть).

Из корня репозитория:

```powershell
cd invoke-ai\scripts
.\tunnel-invoke-from-windows.ps1 -SshUser ВАШ_ЮЗЕР -SshHost IP_ИЛИ_DNS
```

Затем в браузере на ПК: **http://127.0.0.1:9090/** — трафик идёт шифрованно через SSH на ваш сервер.

С нестандартным SSH-портом задайте в `~/.ssh/config` хост с `Port`, а в скрипт передавайте `SshHost` как имя из `Host`.

При использовании ключа:

```powershell
.\tunnel-invoke-from-windows.ps1 -SshUser deploy -SshHost 203.0.113.50 -IdentityFile $env:USERPROFILE\.ssh\id_ed25519
```

## 3. Опционально: HTTPS и домен

Если нужен доступ без SSH (команда / телефон):

- Поднимите **Caddy** или **Nginx** на сервере, TLS (Let’s Encrypt), **базовую авторизацию** или VPN (Tailscale/WireGuard).
- InvokeAI лучше не оставлять открытым в интернет без защиты.

## 4. Связка с ботом Амина

- Пока основная генерация в боте идёт через Hugging Face / OpenRouter (`bot/src/ai/image-gen.ts`).
- Когда Invoke стабильно доступен по внутреннему URL, можно добавить переменные окружения бота и вызывать **HTTP API Invoke** (см. `/docs` на вашем инстансе после входа в UI) — это отдельный шаг интеграции.

## Полезные команды

```bash
docker compose ps
docker compose restart
docker compose down
```

Образ: `ghcr.io/invoke-ai/invokeai` — обновление: `docker compose pull && docker compose up -d`.
