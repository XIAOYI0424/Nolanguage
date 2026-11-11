/**
 * The logger factory interface.
 *
 * Its own file rather than a corner of `types.ts`: it is the one log type that
 * needs `Logger`, and putting it beside `Logger` keeps `types.ts` free of
 * imports — which is what lets the whole graph point at it without a cycle.
 */
import type { Logger } from './Logger.js';

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
