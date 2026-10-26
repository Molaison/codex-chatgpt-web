export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;
  private finalValue?: { value: T };

  constructor(
    private readonly maxBuffered = 10_000,
    private readonly coalesce?: (previous: T, next: T) => T | undefined,
  ) {}

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    const last = this.buffered.length - 1;
    if (last >= 0 && this.coalesce) {
      const combined = this.coalesce(this.buffered[last]!, value);
      if (combined !== undefined) {
        this.buffered[last] = combined;
        return;
      }
    }
    if (this.buffered.length >= this.maxBuffered) throw new Error("Adapter event backlog exceeded");
    this.buffered.push(value);
  }

  /** A terminal failure must remain deliverable even when the producer filled the backlog. */
  close(finalValue?: T): void {
    if (this.closed) return;
    this.closed = true;
    if (finalValue !== undefined) this.finalValue = { value: finalValue };
    if (this.finalValue && this.waiters.length > 0) {
      this.waiters.shift()!({ value: this.finalValue.value, done: false });
      this.finalValue = undefined;
    }
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
        if (this.finalValue) {
          const finalValue = this.finalValue.value;
          this.finalValue = undefined;
          return Promise.resolve({ value: finalValue, done: false });
        }
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
