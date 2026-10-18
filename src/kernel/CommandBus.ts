import type {
  CommandBus, CommandHandler, CommandMeta, CommandMiddleware, CommandContext, Disposable,
} from './types.js';

/**
 * Command bus: register handlers, execute with a middleware chain.
 * Middleware added via `use` wraps the handler (auto-instrumentation hook).
 */
export class CommandBusImpl implements CommandBus {
  private handlers = new Map<string, { handler: CommandHandler; meta: CommandMeta }>();
  private middlewares: CommandMiddleware[] = [];

  register<A extends unknown[] = unknown[], R = unknown>(
    id: string,
    handler: (...args: A) => R | Promise<R>,
    meta?: Partial<CommandMeta>,
  ): Disposable {
    if (this.handlers.has(id)) {
      throw new Error(`Command already registered: ${id}`);
    }
    // The bus dispatches positionally, so a typed handler is safe to store as
    // the loose shape; `execute` is the only caller.
    this.handlers.set(id, { handler: handler as unknown as CommandHandler, meta: { id, ...meta } });
    return { dispose: () => { this.handlers.delete(id); } };
  }

  use(mw: CommandMiddleware): Disposable {
    this.middlewares.push(mw);
    return {
      dispose: () => {
        const i = this.middlewares.indexOf(mw);
        if (i >= 0) this.middlewares.splice(i, 1);
      },
    };
  }

  has(id: string): boolean {
    return this.handlers.has(id);
  }

  list(): CommandMeta[] {
    return [...this.handlers.values()].map((h) => h.meta);
  }

  async execute<T = unknown>(id: string, ...args: unknown[]): Promise<T> {
    const entry = this.handlers.get(id);
    if (!entry) throw new Error(`Command not found: ${id}`);
    const ctx: CommandContext = { id, meta: entry.meta, args };

    const final = async (a: unknown[]): Promise<unknown> => entry.handler(...a);
    let chain: (a: unknown[]) => Promise<unknown> = final;
    // Wrap middlewares in reverse so the first `use` runs outermost.
    for (let i = this.middlewares.length - 1; i >= 0; i--) {
      const mw = this.middlewares[i];
      const next = chain;
      chain = (a) => mw(ctx, next);
    }
    return (await chain(args)) as T;
  }
}
