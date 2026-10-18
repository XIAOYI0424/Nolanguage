import { performance } from 'node:perf_hooks';
import type { EventBus, EventHandler, Disposable } from './types.js';

type EmitObserver = (event: string, durationMs: number, handlerCount: number) => void;

/**
 * Event bus: pub/sub with on/once/emit. An internal observer is used by the
 * performance spine to auto-instrument emit timing (no public `use` in spec).
 */
export class EventBusImpl implements EventBus {
  private handlers = new Map<string, Set<EventHandler>>();
  private observer?: EmitObserver;

  observe(fn: EmitObserver): void {
    this.observer = fn;
  }

  on<T = unknown>(event: string, handler: EventHandler<T>): Disposable {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as EventHandler);
    return { dispose: () => { set!.delete(handler as EventHandler); } };
  }

  once<T = unknown>(event: string, handler: EventHandler<T>): Disposable {
    const wrap: EventHandler = (p) => {
      this.off(event, wrap);
      return handler(p as T);
    };
    return this.on(event, wrap);
  }

  private off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  has(event: string): boolean {
    return (this.handlers.get(event)?.size ?? 0) > 0;
  }

  async emit<T = unknown>(event: string, payload?: T): Promise<void> {
    const set = this.handlers.get(event);
    const count = set?.size ?? 0;
    if (count === 0) return;
    const t0 = performance.now();
    await Promise.all([...set!].map((h) => h(payload)));
    const dur = performance.now() - t0;
    this.observer?.(event, dur, count);
  }
}
