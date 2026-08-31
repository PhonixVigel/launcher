# ====================================================
# VozduCraft Master Backend & Admin Panel Dockerfile
# ====================================================
FROM node:20-alpine AS builder

WORKDIR /app

# Установка зависимостей для сборки SQLite и TypeScript
RUN apk add --no-cache python3 make g++

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# Stage 2: Production Runtime
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=/app/data/vozducraft.db

RUN apk add --no-cache sqlite-libs

COPY package*.json ./
RUN npm ci --only=production

# Копируем скомпилированный код бэкенда
COPY --from=builder /app/dist ./dist

# Копируем публичные статические файлы (Web Admin UI и хранилище файлов)
COPY public/ ./public/

# Создаем директории для постоянных данных (Persistent Volumes)
RUN mkdir -p /app/data /app/public/files/mods /app/public/files/releases

EXPOSE 3000

VOLUME ["/app/data", "/app/public/files"]

CMD ["node", "dist/index.js"]
