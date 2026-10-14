import type { LoggerFactory, LogResourceScope, LogCorrelation } from '../kernel/types.js';
import type { LogEnvironment } from './types.js';
import { LoggerImpl } from './Logger.js';
import type { LogPipeline } from './LogPipeline.js';

/** LoggerFactory: build scoped loggers for extensions / components / kernel. */
export class LogFactory implements LoggerFactory {
  constructor(
    private pipeline: LogPipeline,
    private environment: LogEnvironment,
    private baseCorrelation: Partial<LogCorrelation>,
  ) {}

  private make(
    scope: LogResourceScope,
    component: string,
    extra: { extensionId?: string; languageId?: string; correlation?: Partial<LogCorrelation> } = {},
  ): LoggerImpl {
    return new LoggerImpl(
      {
        resourceScope: scope,
        component,
        extensionId: extra.extensionId,
        languageId: extra.languageId,
        correlation: { ...this.baseCorrelation, ...(extra.correlation ?? {}) },
        environment: this.environment,
      },
      this.pipeline,
    );
  }

  forExtension(id: string): LoggerImpl {
    return this.make('extension', `extension.${id}`, { extensionId: id });
  }

  forComponent(name: string): LoggerImpl {
    return this.make('kernel', name);
  }

  forLanguageServer(languageId: string, component?: string): LoggerImpl {
    return this.make('language-server', component ?? `lsp.${languageId}`, { languageId });
  }

  forExecution(component: string, sessionId?: string): LoggerImpl {
    return this.make('execution', component, {
      correlation: sessionId ? { sessionId } : undefined,
    });
  }

  forUserCode(languageId: string, sessionId?: string): LoggerImpl {
    return this.make('user-code', `user-code.${languageId}`, {
      languageId,
      correlation: sessionId ? { sessionId } : undefined,
    });
  }

  root(): LoggerImpl {
    return this.make('kernel', 'kernel');
  }
}
