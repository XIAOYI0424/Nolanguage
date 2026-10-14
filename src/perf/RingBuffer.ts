/**
 * Fixed-capacity circular buffer (O(1) push, no allocations on push).
 * Used as the hot store for both perf records and log records.
 */
export class RingBuffer<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private _size = 0;

  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error('RingBuffer capacity must be > 0');
    this.buf = new Array(capacity);
  }

  get size(): number {
    return this._size;
  }

  get isFull(): boolean {
    return this._size === this.capacity;
  }

  push(item: T): void {
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this._size < this.capacity) this._size++;
  }

  toArray(): T[] {
    const out: T[] = [];
    const start = this.isFull ? this.head : 0;
    for (let i = 0; i < this._size; i++) {
      const idx = (start + i) % this.capacity;
      out.push(this.buf[idx] as T);
    }
    return out;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this._size = 0;
  }
}
