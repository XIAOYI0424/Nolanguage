import { performance } from 'node:perf_hooks';
import type { ServiceRegistry, ServiceFactory, ServiceOptions, ServiceContext, Disposable, Kernel } from './types.js';

type ActivationObserver = (id: string, ms: number, ok: boolean) => void;

/**
 * Service registry with lifecycle + lazy DI. Singleton services are cached and
 * activated once; activation time is reported to the performance spine.
 */
export class ServiceRegistryImpl implements ServiceRegistry {
  private factories = new Map<string, { factory: ServiceFactory; opts: Required<ServiceOptions> }>();
  private singletons = new Map<string, unknown>();
  private observer?: ActivationObserver;
  private kernel!: Kernel;

  attach(kernel: Kernel): void {
    this.kernel = kernel;
  }

  register<T = unknown>(id: string, factory: ServiceFactory<T>, opts: ServiceOptions = {}): Disposable {
    this.factories.set(id, {
      factory: factory as ServiceFactory,
      opts: { lifecycle: opts.lifecycle ?? 'singleton', lazy: opts.lazy ?? true },
    });
    return { dispose: () => { this.factories.delete(id); this.singletons.delete(id); } };
  }

  has(id: string): boolean {
    return this.factories.has(id);
  }

  setActivationObserver(fn: ActivationObserver): void {
    this.observer = fn;
  }

  consume<T = unknown>(id: string): T {
    const entry = this.factories.get(id);
    if (!entry) throw new Error(`Service not registered: ${id}`);
    if (entry.opts.lifecycle === 'singleton' && this.singletons.has(id)) {
      return this.singletons.get(id) as T;
    }
    const t0 = performance.now();
    const ctx: ServiceContext = { kernel: this.kernel, id };
    const value = entry.factory(ctx) as T;
    const ms = performance.now() - t0;
    if (entry.opts.lifecycle !== 'transient') this.singletons.set(id, value);
    this.observer?.(id, ms, true);
    return value;
  }

  dispose(id: string): void {
    this.factories.delete(id);
    this.singletons.delete(id);
  }
}
