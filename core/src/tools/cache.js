/**
 * Кеш ответов биржи с временем жизни.
 *
 * Нужен не ради скорости, а ради лимитов. У Binance квота считается «весом»
 * запросов на адрес, и самый дорогой наш вызов — сводка по всем торговым
 * парам — весит на два порядка больше обычной котировки. Один план вполне
 * может запросить цену BTC трижды: сравнить с ETH, посчитать долю, показать
 * в отчёте. Без кеша на десяток пользователей мы упрёмся в 429.
 *
 * Время жизни задаётся на инструмент, а не одно на всех: срез стакана
 * устаревает за секунды, суточная сводка — нет.
 */
export class TtlCache {
  #entries = new Map();

  /** @param {{ maxEntries?: number, now?: () => number }} [options] */
  constructor({ maxEntries = 500, now = () => Date.now() } = {}) {
    this.maxEntries = maxEntries;
    this.now = now;
  }

  /**
   * Возвращает значение из кеша либо вычисляет и запоминает его.
   *
   * @template T
   * @param {string} key
   * @param {number} ttlMs время жизни; 0 отключает кеширование
   * @param {() => Promise<T>} produce
   * @returns {Promise<T>}
   */
  async through(key, ttlMs, produce) {
    if (ttlMs <= 0) return produce();

    const hit = this.#entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value;

    const value = await produce();
    this.#set(key, value, ttlMs);
    return value;
  }

  /** Сколько записей сейчас хранится (для тестов и диагностики). */
  get size() {
    return this.#entries.size;
  }

  clear() {
    this.#entries.clear();
  }

  #set(key, value, ttlMs) {
    // Записи не истекают сами по себе — таймеры на каждый ключ держали бы
    // процесс живым. Вместо этого чистим просроченное при переполнении, и
    // только если этого не хватило, выбрасываем самую старую по вставке.
    if (this.#entries.size >= this.maxEntries) this.#evict();
    this.#entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  #evict() {
    const now = this.now();
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(key);
    }
    if (this.#entries.size >= this.maxEntries) {
      const oldest = this.#entries.keys().next();
      if (!oldest.done) this.#entries.delete(oldest.value);
    }
  }
}
