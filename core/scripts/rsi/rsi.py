#!/usr/bin/env python3
"""
Расчёт RSI (Relative Strength Index, индекс относительной силы) по ценам
закрытия свечей Binance.

Считает библиотека TA-Lib, а не наш код, и это осознанно: RSI Уайлдера
рекурсивен — среднее приращение сглаживается по всему ряду от начала, — и
самодельная реализация расходится с биржевыми терминалами на мелочах вроде
затравки первого среднего. TA-Lib засевает его простым средним за `length`
баров, как в оригинальной книге, и совпадает с эталонными значениями до
четвёртого знака (проверено тестом `core/test/rsi.test.js`).

Почему TA-Lib, а не pandas_ta (ТЗ разрешает любую из двух):
  * pandas_ta 0.4 тянет за собой numba и llvmlite — 73 МБ колёс против 20 МБ
    у TA-Lib, и под musl (Alpine, на котором собран образ Core) колёс numba
    нет вовсе: пришлось бы менять базовый образ сервиса;
  * его RSI засевает сглаживание не средним, а первым же приращением, и на
    коротком ряде расходится с классическим RSI на величину до 16 пунктов —
    для показателя со шкалой 0..100 это не мелочь.

ПОДДЕРЖИВАЮТСЯ ТОЛЬКО BTC И ETH. Ограничение живёт здесь, а не только в
вызывающем коде: скрипт — самостоятельная утилита, и запуск руками не должен
обходить правило. Символ проверяется по списку до того, как из него что-либо
соберут, поэтому подставить в запрос чужую пару нельзя.

Данные берутся из stdin, а когда его нет — с публичного API Binance:
  * Core передаёт свечи через stdin (флаг --no-fetch): у него уже есть
    HTTP-клиент биржи с кешем, таймаутами и разбором её кодов ошибок, и второй
    такой же в подпроцессе только плодил бы расхождения;
  * без stdin скрипт ходит на биржу сам — чтобы его можно было запустить
    руками и получить число, не поднимая весь сервис.

Запуск:
    python3 rsi.py --symbol BTC
    python3 rsi.py --symbol ETH --interval 4h --length 14
    echo '{"closes": [1, 2, 3]}' | python3 rsi.py --symbol BTC --no-fetch

Вывод — всегда JSON в stdout. Код возврата: 0 — успех, 1 — отказ с понятной
причиной (поле code), больше — непредвиденный сбой, подробности в stderr.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

# Пары, для которых считаем. Ключи — то, что может написать пользователь или
# модель; значения — символ Binance.
SUPPORTED = {
    "BTC": "BTCUSDT",
    "BTCUSDT": "BTCUSDT",
    "ETH": "ETHUSDT",
    "ETHUSDT": "ETHUSDT",
}

# Фраза уходит пользователю почти дословно, поэтому живёт одной константой:
# в Core её дублирует RSI_ONLY_BTC_ETH из src/tools/rsi.js.
UNSUPPORTED_MESSAGE = (
    "Пока показатель RSI считается только для BTC и ETH. "
    "Для остальных монет доступны цена, объёмы, свечи и стакан."
)

# Интервалы свечей Binance. Проверяем по списку по той же причине, что и
# символ: значение попадает в запрос к бирже.
INTERVALS = (
    "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
)

DEFAULT_LENGTH = 14
DEFAULT_INTERVAL = "1h"

# Сколько свечей просить у биржи. RSI рекурсивен: значение на последнем баре
# зависит от всей предыдущей истории, и посчитанный по сотне баров он не
# совпадёт с тем, что показывает терминал по тысяче. Расхождение затухает
# примерно за 250 баров, поэтому берём предел Binance на один запрос.
DEFAULT_CANDLES = 500

# Сколько последних значений показывать помимо текущего: по ним видно
# направление, а длинный ряд в отчёте всё равно никто не читает.
RECENT_POINTS = 5

OVERBOUGHT = 70
OVERSOLD = 30

BINANCE_KLINES_URL = "https://api.binance.com/api/v3/klines"
FETCH_TIMEOUT_SECONDS = 10


class Refusal(Exception):
    """Отказ с понятной причиной: попадёт в stdout как JSON, а не трассировкой."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Расчёт RSI по ценам закрытия. Поддерживаются только BTC и ETH.",
    )
    parser.add_argument("--symbol", required=True, help="BTC, ETH, BTCUSDT или ETHUSDT")
    parser.add_argument("--interval", default=DEFAULT_INTERVAL, help=f"размер свечи (по умолчанию {DEFAULT_INTERVAL})")
    parser.add_argument("--length", type=int, default=DEFAULT_LENGTH, help=f"период RSI (по умолчанию {DEFAULT_LENGTH})")
    parser.add_argument(
        "--no-fetch",
        action="store_true",
        help="не ходить на биржу: цены закрытия обязаны прийти в stdin",
    )
    return parser.parse_args(argv)


def require_symbol(value: str) -> str:
    symbol = value.strip().upper()
    if symbol not in SUPPORTED:
        raise Refusal("unsupported_symbol", UNSUPPORTED_MESSAGE)
    return SUPPORTED[symbol]


def require_interval(value: str) -> str:
    if value not in INTERVALS:
        raise Refusal("bad_input", f"Интервал свечей должен быть одним из: {', '.join(INTERVALS)}.")
    return value


def require_length(value: int) -> int:
    # Верхняя граница — не придирка: период должен оставлять место для истории
    # внутри 500 свечей, иначе считать будет не по чему.
    if not 2 <= value <= 100:
        raise Refusal("bad_input", "Период RSI должен быть целым числом от 2 до 100.")
    return value


def read_closes(stream) -> list[float] | None:
    """Цены закрытия из stdin. None — данных не передали, надо идти на биржу."""
    if stream is None or stream.isatty():
        return None

    raw = stream.read().strip()
    if not raw:
        return None

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        raise Refusal("bad_input", f"На stdin ожидался JSON: {error}.") from error

    # Допускаем и голый массив, и объект: первое удобно набрать руками,
    # второе оставляет место для полей помимо цен.
    closes = payload.get("closes") if isinstance(payload, dict) else payload
    if not isinstance(closes, list):
        raise Refusal("bad_input", "В JSON на stdin нет массива closes.")

    try:
        return [float(value) for value in closes]
    except (TypeError, ValueError) as error:
        raise Refusal("bad_input", f"Цены закрытия должны быть числами: {error}.") from error


def fetch_closes(symbol: str, interval: str, limit: int = DEFAULT_CANDLES) -> list[float]:
    """Свечи с публичного API Binance. Ключи не нужны: эндпоинт открытый."""
    query = urllib.parse.urlencode({"symbol": symbol, "interval": interval, "limit": limit})
    request = urllib.request.Request(
        f"{BINANCE_KLINES_URL}?{query}",
        headers={"Accept": "application/json"},
    )

    try:
        with urllib.request.urlopen(request, timeout=FETCH_TIMEOUT_SECONDS) as response:
            rows = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        raise Refusal("fetch_failed", f"Binance ответила {error.code}.") from error
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise Refusal("fetch_failed", f"Не удалось получить свечи с Binance: {error}.") from error

    if not isinstance(rows, list) or not rows:
        raise Refusal("fetch_failed", "Binance вернула пустой список свечей.")

    # Свеча Binance — массив; цена закрытия четвёртая по счёту.
    return [float(row[4]) for row in rows]


def compute(symbol: str, interval: str, length: int, closes: list[float]) -> dict:
    try:
        import numpy
        import talib
    except ImportError as error:
        raise Refusal(
            "dependency_missing",
            f"Не установлена библиотека расчёта индикаторов ({error.name}). "
            f"Установка: pip install -r core/scripts/rsi/requirements.txt",
        ) from error

    if len(closes) <= length:
        raise Refusal(
            "not_enough_data",
            f"Для RSI({length}) нужно больше {length} цен закрытия, получено {len(closes)}.",
        )

    values = talib.RSI(numpy.asarray(closes, dtype="float64"), timeperiod=length)

    # Первые length значений TA-Lib оставляет пустыми: сглаживанию не на чем
    # завестись. Отбрасываем их, а не показываем как нули.
    ready = [float(value) for value in values if value == value]  # NaN != NaN
    if not ready:
        raise Refusal("not_enough_data", "RSI не рассчитался: слишком короткий ряд цен.")

    current = round(ready[-1], 2)
    return {
        "symbol": symbol,
        "interval": interval,
        "length": length,
        "rsi": current,
        "zone": zone(current),
        # От старых к новым, как читается график.
        "recent": [round(value, 2) for value in ready[-RECENT_POINTS - 1 : -1]],
        "overbought": OVERBOUGHT,
        "oversold": OVERSOLD,
        "samples": len(closes),
    }


def zone(value: float) -> str:
    """Толкование шкалы. Считаем здесь: у порогов есть общепринятые значения,
    и оставлять их на усмотрение языковой модели незачем."""
    if value >= OVERBOUGHT:
        return "перекупленность"
    if value <= OVERSOLD:
        return "перепроданность"
    return "нейтральная"


def main(argv: list[str]) -> int:
    args = parse_args(argv)

    try:
        symbol = require_symbol(args.symbol)
        interval = require_interval(args.interval)
        length = require_length(args.length)

        closes = read_closes(sys.stdin)
        if closes is None:
            if args.no_fetch:
                raise Refusal("bad_input", "Цены закрытия не переданы в stdin, а поход на биржу запрещён флагом --no-fetch.")
            closes = fetch_closes(symbol, interval)

        result = compute(symbol, interval, length, closes)
    except Refusal as refusal:
        json.dump({"ok": False, "code": refusal.code, "message": str(refusal)}, sys.stdout, ensure_ascii=False)
        print()
        return 1

    json.dump({"ok": True, **result}, sys.stdout, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
