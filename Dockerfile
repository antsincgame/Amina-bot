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

# Build with env vars for admin panel (Vite inlines at build time)
ARG VITE_BOT_URL
ARG VITE_APPWRITE_ENDPOINT
ARG VITE_APPWRITE_PROJECT_ID
ENV VITE_BOT_URL=${VITE_BOT_URL}
ENV VITE_APPWRITE_ENDPOINT=${VITE_APPWRITE_ENDPOINT}
ENV VITE_APPWRITE_PROJECT_ID=${VITE_APPWRITE_PROJECT_ID}

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

WORKDIR /app/bot
CMD ["./node_modules/.bin/tsx", "src/index.ts"]
