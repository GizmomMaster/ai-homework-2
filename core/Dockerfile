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

# --- Зависимости расчёта индикаторов ----------------------------------------
# RSI считает Python-скрипт поверх TA-Lib (см. src/tools/rsi.js). Ставим в
# отдельный venv: системный python в Alpine помечен как externally-managed, и
# pip в него не пишет. Библиотека приезжает готовым колесом под musl —
# компилятор и системная libta-lib не нужны, поэтому слой отдельный от сборки
# better-sqlite3 и в нём нет ничего лишнего.
FROM node:20-alpine AS python

RUN apk add --no-cache python3 py3-pip && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir --upgrade pip
COPY scripts/rsi/requirements.txt /tmp/requirements.txt
RUN /opt/venv/bin/pip install --no-cache-dir -r /tmp/requirements.txt

# --- Финальный образ --------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

# Интерпретатор нужен и в рантайме: venv — это только пакеты и ссылки на него.
RUN apk add --no-cache python3
COPY --from=python /opt/venv /opt/venv

# venv впереди PATH: python3 в образе — это интерпретатор с TA-Lib, и
# отдельный путь в окружении не нужен (см. src/tools/pythonBin.js). Задать
# его через ENV всё равно не вышло бы: compose пробрасывает core/.env через
# env_file, а он перекрывает ENV образа.
ENV PATH="/opt/venv/bin:$PATH"

COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY skills ./skills

# Каталог для файла SQLite: история диалогов и очередь заданий. Перекрывается
# volume'ом из docker-compose.yml, чтобы данные переживали пересоздание
# контейнера.
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["node", "src/index.js"]
