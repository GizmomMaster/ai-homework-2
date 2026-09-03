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
   * **`undefined` не кешируется** и возвращается как есть. Это способ для
   * вызывающего кода сказать «ответа нет, но запомнить это нечестно»: неудача
   * из-за оборванной сети не должна закрепиться на всё время жизни записи и
   * превратиться в постоянный пробел в отчёте. Значение, которое нужно
   * запомнить, включая пустое, передаётся как `null`.
   *
   * **В записи лежит промис, а не готовое значение**, и это существенно.
   * Между началом вычисления и его концом проходит поход по сети, а шаги
   * плана выполняются одновременно (см. CONCURRENCY в PlanExecutor): пока
   * запись появлялась только после await, два шага по одной паре успевали
   * оба промахнуться мимо кеша и сходить на биржу порознь — то есть ровно в
   * том случае, ради которого кеш и заводился. Срок жизни при этом идёт от
   * начала вычисления, а не от его конца: запись живёт на время запроса
   * короче, и это дешевле лишнего похода на биржу.
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

    const pending = produce();
    this.#set(key, pending, ttlMs);

    let value;
    try {
      value = await pending;
    } catch (error) {
      // Отказ не запоминаем — по той же причине, по которой не запоминаем
      // `undefined`. Ждавшие этот же промис получат ту же ошибку (один поход
      // на биржу на всех), а следующий вызов начнёт заново.
      this.#forget(key, pending);
      throw error;
    }

    if (value === undefined) this.#forget(key, pending);
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

  /**
   * Убирает свою запись — но только если она всё ещё своя: за время ожидания
   * её мог вытеснить {@link #evict}, а на её месте оказаться чужая, более
   * свежая. Стирать её значило бы наказать за чужую неудачу.
   */
  #forget(key, pending) {
    if (this.#entries.get(key)?.value === pending) this.#entries.delete(key);
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
