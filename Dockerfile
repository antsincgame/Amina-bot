# ============================================
# Stage 1: Build Admin Panel
# ============================================
FROM node:20-alpine AS admin-build

WORKDIR /app/admin

# Copy shared types first (admin imports from ../shared)
COPY shared/ /app/shared/

# Install admin dependencies (need devDeps for tsc/vite)
COPY admin/package.json admin/package-lock.json ./
RUN NODE_ENV=development npm ci

# Copy admin source
COPY admin/ ./

# Build with empty BOT_URL (same origin) and Supabase vars from build args
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ENV VITE_BOT_URL=""
ENV VITE_SUPABASE_URL=${VITE_SUPABASE_URL}
ENV VITE_SUPABASE_ANON_KEY=${VITE_SUPABASE_ANON_KEY}

RUN npm run build

# ============================================
# Stage 2: Bot Runtime
# ============================================
FROM node:20-alpine

WORKDIR /app

# Copy shared types
COPY shared/ ./shared/

# Install bot dependencies
COPY bot/package.json bot/package-lock.json ./bot/
RUN cd bot && npm ci --omit=dev

# Copy bot source
COPY bot/ ./bot/

# Copy admin build from stage 1
COPY --from=admin-build /app/admin/dist ./admin-dist/

# Environment
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD wget -qO- http://localhost:3000/health || exit 1

WORKDIR /app/bot
CMD ["npx", "tsx", "src/index.ts"]
