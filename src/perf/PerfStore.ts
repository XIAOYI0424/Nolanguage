import { RingBuffer } from '../util/ringBuffer.js';
import type { PerfRecord } from './types.js';

/** Hot store for raw PerfRecords backed by a ring buffer (latest N records). */
export class PerfStore {
  private ring: RingBuffer<PerfRecord>;

  constructor(capacity: number) {
    this.ring = new RingBuffer(capacity);
  }

  push(r: PerfRecord): void {
    this.ring.push(r);
  }

  recent(limit: number): PerfRecord[] {
    return this.ring.toArray().slice(-limit);
  }

  all(): PerfRecord[] {
    return this.ring.toArray();
  }
}
