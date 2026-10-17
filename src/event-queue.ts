export class EventQueueOverflowError extends Error {
  constructor() { super("Adapter event backlog exceeded"); }
}

export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  constructor(private readonly maxBuffered = 10_000) {}

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    if (this.buffered.length >= this.maxBuffered) throw new EventQueueOverflowError();
    this.buffered.push(value);
  }

  /** Replace undelivered output with one failure, even when ordinary capacity is full. */
  fail(value: T): void {
    if (this.closed) return;
    this.buffered.length = 0;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.buffered.push(value);
    this.close();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0) this.waiters.shift()!({ value: undefined, done: true });
  }

  async collect(): Promise<T[]> {
    const values: T[] = [];
    for await (const value of this) values.push(value);
    return values;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.buffered.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: () => {
        this.buffered.length = 0;
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
