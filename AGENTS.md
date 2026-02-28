# AGENTS.md

## Cursor Cloud specific instructions

### Project overview
Amina Bot is a Telegram AI chatbot with an admin panel. Two main services:
- **Bot backend** (`bot/`) — Node.js/TypeScript, grammy + Fastify HTTP server on port 3000
- **Admin panel** (`admin/`) — React + Vite + Tailwind on port 3001

### Package manager
Uses **npm** (lockfiles are `package-lock.json` in `bot/`, `admin/`, and `mcp-servers/`).

### Running services
- **Bot**: `npm run dev` in `bot/` (uses `tsx watch`). Requires valid `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` in `bot/.env`. Will crash at startup if the Telegram token is invalid (fails on `bot.api.setMyCommands`). The HTTP server starts before the crash, so health endpoints work briefly.
- **Admin**: `npm run dev` in `admin/` (Vite dev server, port 3001). Requires `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `admin/.env`.

### Running tests
- **Bot tests**: `npm test` in `bot/` (vitest, 272 tests). Test env vars are set automatically in `vitest.config.ts` and `src/test/setup.ts` — no real credentials needed.
- **Admin**: no tests currently configured.

### Typecheck
- `npm run typecheck` in both `bot/` and `admin/`.

### Lint
- `npm run lint` is defined in both `bot/` and `admin/` `package.json` but **ESLint config files are missing** from the repository. The lint commands will fail with "couldn't find a configuration file".

### Build
- `npm run build` in `admin/` runs `tsc && vite build`.
- `npm run build` in `bot/` is a no-op (uses tsx at runtime).

### Environment variables
See `bot/.env.example` and `admin/.env.example`. The bot requires `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` to start; all other keys (`TELEGRAM_BOT_TOKEN`, `OPENROUTER_API_KEY`, etc.) are optional at startup and can be configured via the admin panel's database settings.
