# --- Сборка нативной зависимости (better-sqlite3) ---------------------------
# Отдельный слой: компиляторы нужны только здесь и в финальный образ не едут.
FROM node:20-alpine AS build

WORKDIR /app

# better-sqlite3 — нативный аддон; готовой сборки под musl (Alpine) нет,
# поэтому ставим инструменты для компиляции из исходников.
RUN apk add --no-cache python3 make g++

# npm ci ставит ровно то, что записано в package-lock.json — воспроизводимо
# и без сюрпризов при пересборке образа.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Финальный образ --------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Каталог для файла SQLite. Обычно перекрывается volume'ом из
# docker-compose.yml, чтобы история переписки переживала пересоздание
# контейнера.
RUN mkdir -p /app/data

CMD ["node", "src/index.js"]
