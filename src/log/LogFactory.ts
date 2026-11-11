import type { LoggerFactory } from './LoggerFactory.js';
import type { LogResourceScope } from './types.js';
import type { LogCorrelation } from '../correlation/types.js';
import type { LogEnvironment } from '../util/env.js';
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

  /**
   * The render log scope of stage 8 ("Markdown: ... + render"): every preview
   * render reports here, so the Logs tab can show render latency per document
   * the way execution logs show run latency.
   */
  forMarkdown(component = 'markdown.render'): LoggerImpl {
    return this.make('markdown', component, { languageId: 'markdown' });
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
