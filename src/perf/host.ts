/**
 * The port `PerfSpine` needs from whatever hosts it.
 *
 * The spine used to take a `Kernel`, which meant `perf` imported the kernel
 * while the kernel owned the spine — a cycle. A host interface inverts that: the
 * spine declares what it needs, the kernel adapts, and `perf` no longer knows the
 * kernel exists.
 *
 * Everything here points *down*: `Tracer` and `Span` are perf's own, `Logger` is
 * the log slice below it.
 */
import type { LoggerFactory } from '../log/LoggerFactory.js';
import type { Span } from './types.js';
import type {
  PerfActivationObserver,
  PerfCommandMiddleware,
  PerfEventObserver,
  PerfEventSink,
  PerfServiceRegistry,
} from './types.js';

export interface PerfTracer {
  startSpan(name: string, opts?: { attributes?: Record<string, unknown> }): Span;
}

/** A bus that can also report what it did, for the metric taps. */
export interface PerfEventBus extends PerfEventSink {
  observe?(cb: PerfEventObserver): void;
}

export interface PerfHost {
  /**
   * Attach the command middleware. A function rather than the bus itself: the
   * kernel's `CommandBus.use` has a wider signature than the spine needs, and
   * forcing the two to match field for field would be coupling for its own sake.
   */
  onCommand(mw: PerfCommandMiddleware): void;
  tracer: PerfTracer;
  logger: Pick<LoggerFactory, 'forComponent'>;
  events: PerfEventBus;
  services?: PerfServiceRegistry;
}

export type { PerfActivationObserver, PerfEventObserver };
