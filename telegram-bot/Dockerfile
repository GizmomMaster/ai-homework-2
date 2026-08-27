FROM node:20-alpine

WORKDIR /app

# better-sqlite3 — нативный аддон; на случай отсутствия готовой сборки под
# musl (Alpine) ставим инструменты для компиляции из исходников.
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src

# Каталог для файла SQLite (обычно перекрывается volume'ом из docker-compose.yml,
# чтобы история переписки переживала пересоздание контейнера).
RUN mkdir -p /app/data

CMD ["node", "src/index.js"]
