import type { Tracer } from '../perf/Tracer.js';
import type { CorrelationBus } from '../correlation/CorrelationBus.js';
import type { Logger } from '../log/Logger.js';

export type Disposable = { dispose(): void };

// ---------------- Command bus ----------------

export interface CommandMeta {
  id: string;
  title?: string;
  category?: string;
  description?: string;
}

export type CommandHandler = (...args: unknown[]) => unknown | Promise<unknown>;

export interface CommandContext {
  id: string;
  meta?: CommandMeta;
  args: unknown[];
}

export type CommandMiddleware = (
  ctx: CommandContext,
  next: (args: unknown[]) => Promise<unknown>,
) => Promise<unknown>;

export interface CommandBus {
  /**
   * Register a handler. `A` is the handler's parameter tuple: a typed handler
   * such as `(languageId: SandboxLanguage, sessionId?: string) => Promise<…>`
   * is assignable even though the bus stores it as a loose `CommandHandler`
   * (the bus cannot know a command's signature at the call site).
   */
  register<A extends unknown[] = unknown[], R = unknown>(
    id: string,
    handler: (...args: A) => R | Promise<R>,
    meta?: Partial<CommandMeta>,
  ): Disposable;
  execute<T = unknown>(id: string, ...args: unknown[]): Promise<T>;
  use(mw: CommandMiddleware): Disposable;
  has(id: string): boolean;
  list(): CommandMeta[];
}

// ---------------- Event bus ----------------

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export interface EventBus {
  on<T = unknown>(event: string, handler: EventHandler<T>): Disposable;
  once<T = unknown>(event: string, handler: EventHandler<T>): Disposable;
  emit<T = unknown>(event: string, payload?: T): Promise<void>;
  has(event: string): boolean;
}

// ---------------- Service registry ----------------

export type ServiceLifecycle = 'singleton' | 'transient' | 'scoped';

export interface ServiceOptions {
  lifecycle?: ServiceLifecycle;
  lazy?: boolean;
}

export interface ServiceContext {
  kernel: Kernel;
  id: string;
}

export type ServiceFactory<T = unknown> = (ctx: ServiceContext) => T;

export interface ServiceRegistry {
  register<T = unknown>(id: string, factory: ServiceFactory<T>, opts?: ServiceOptions): Disposable;
  consume<T = unknown>(id: string): T;
  has(id: string): boolean;
  dispose(id: string): void;
}

// ---------------- Shared correlation + scopes ----------------

export type LogResourceScope =
  | 'kernel' | 'extension' | 'language-server'
  | 'execution' | 'user-code' | 'ai' | 'markdown';

export interface LogCorrelation {
  gitCommit?: string;
  gitBranch?: string;
  configHash?: string;
  sessionId?: string;
  requestId?: string;
  userId?: string;
  traceId?: string;
}

// ---------------- View / Language / Config (later-phase stubs) ----------------

export interface ViewContribution {
  slot: string;
  id: string;
  component?: string;
  when?: string;
}
export interface ViewRegistry {
  register(view: ViewContribution): Disposable;
  get(slot: string): ViewContribution[];
  slots(): string[];
}

export interface LanguageContribution {
  id: string;
  extensions: string[];
  lsp?: string;
  dap?: string;
  profiler?: string;
}
export interface LanguageRegistry {
  register(l: LanguageContribution): Disposable;
  get(id: string): LanguageContribution | undefined;
  all(): LanguageContribution[];
}

export interface ConfigScope {
  get<T = unknown>(key: string, def?: T): T;
  set(key: string, value: unknown): void;
  all(): Record<string, unknown>;
}
export interface Configuration {
  forExtension(id: string): ConfigScope;
  forWorkspace(): ConfigScope;
}

export interface LoggerFactory {
  forExtension(id: string): Logger;
  forComponent(name: string): Logger;
  /** Logger scoped to a language server (scope = 'language-server'). */
  forLanguageServer(languageId: string, component?: string): Logger;
  /** Logger scoped to the execution plane / sandbox (scope = 'execution'). */
  forExecution(component: string, sessionId?: string): Logger;
  /** Logger scoped to user code output (scope = 'user-code'). */
  forUserCode(languageId: string, sessionId?: string): Logger;
  /** Logger scoped to the Markdown render pipeline (scope = 'markdown'). */
  forMarkdown(component?: string): Logger;
  root(): Logger;
}

// ---------------- Kernel ----------------

export interface Kernel {
  commands: CommandBus;
  events: EventBus;
  services: ServiceRegistry;
  views: ViewRegistry;
  languages: LanguageRegistry;
  configuration: Configuration;
  logger: LoggerFactory;
  tracer: Tracer;
  correlation: CorrelationBus;
  start(): Promise<void>;
  stop(): Promise<void>;
}
