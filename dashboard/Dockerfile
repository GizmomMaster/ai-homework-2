# --- Сборка нативной зависимости (better-sqlite3) ---------------------------
# Отдельный слой: компиляторы нужны только здесь и в финальный образ не едут.
# Тот же приём, что в core/Dockerfile — готовой сборки better-sqlite3 под
# musl (Alpine) нет.
FROM node:20-alpine AS build

WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- Финальный образ --------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

EXPOSE 8090

CMD ["node", "src/index.js"]
