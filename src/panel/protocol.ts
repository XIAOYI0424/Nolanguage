/**
 * The panel protocol, in one place.
 *
 * A frame kind used to live in three independent places: the router in
 * `src/panel/server.ts` (`switch (msg.kind)`), the driver in
 * `src/ui/client/50-runtime.js` (`function handle(m)`), and whatever a document
 * happened to say. Adding a kind to one side and forgetting the other fails the
 * same way a typo does — silently, at runtime.
 *
 * These two lists are the register. `scripts/verify-protocol.ts` reads both
 * switches as text and fails when a handled kind is missing here, or when a kind
 * here is handled by neither side. The lists are not consulted at runtime: they
 * cost nothing and exist so the gate has an authority to compare against.
 *
 * Direction is per list, not per name: a request and its answer often share a
 * name (`hover` is sent and answered as `hover`), so the same string may appear
 * in both lists on purpose.
 */

/** Browser/panel → engine. Handled by `switch (msg.kind)` in `attachClient`. */
export const CLIENT_TO_ENGINE = [
  // lifecycle and editor events
  'ping',
  'filter',
  'clear',
  'resetSession',
  'command',
  'check',
  // running code
  'run',
  'runInput',
  'stop',
  'runScript',
  'termExec',
  'termInput',
  // tests
  'testRun',
  'testCancel',
  // debugging
  'debug',
  'debugCmd',
  // language services (each answered by the same name or `<name>Result`)
  'complete',
  'completion',
  'completionResolve',
  'hover',
  'definition',
  'references',
  'renameSymbol',
  'codeAction',
  'signatureHelp',
  'workspaceSymbol',
  'format',
  'folding',
  'inlayHints',
  'mdRender',
  // workspace and files
  'fsList',
  'fsRead',
  'fsWrite',
  'fsCreate',
  'fsRename',
  'fsDelete',
  'applyWorkspaceEdits',
  'openFolder',
  'projectsDetect',
  'nativePick',
  // crash-recovery drafts
  'draftSave',
  'draftList',
  'draftDrop',
  // local revision history
  'historyList',
  'historyRead',
  'historyRevert',
  // languages, plugins, dependencies
  'listPlugins',
  'langEnable',
  'langDisable',
  'langUninstall',
  'langInstall',
  'catalogSearch',
  'reclaimResources',
  'depsAdd',
  'depsSync',
  'dependencyReport',
  'dependencyInstall',
  'dependencyCancel',
  'interpreters',
  'setInterpreter',
  'envCreate',
  'importIdea',
  'attribute',
  // MCP
  'mcpList',
  'mcpReload',
  'mcpInitConfig',
  'mcpConnect',
  'mcpDisconnect',
  'mcpCall',
  // extensions
  'listExtensions',
  'runExtensionCommand',
  'activateExtension',
  // project templates and run configurations
  'templatesList',
  'templatesGenerate',
  'runConfigsList',
  'runConfigsSave',
  'runConfigsDelete',
  // profiler / coverage / flame sampler
  'profile',
  'profileLast',
  'profileCaps',
  'coverage',
  'flameStart',
  'flameStop',
  // git
  'gitStatus',
  'gitCommit',
  // AI assistant
  'aiConfig',
  'aiSetConfig',
  'aiAsk',
  'aiCancel',
  // sandboxed execution
  'sandboxCreate',
  'sandboxRun',
  'sandboxReset',
  'sandboxList',
] as const;

/** Engine → browser/panel. Handled by `function handle(m)` in `50-runtime.js`. */
export const ENGINE_TO_CLIENT = [
  // connection
  'hello',
  'workspace',
  'plugins',
  'catalog',
  'log',
  'metrics',
  // editor services
  'definitionResult',
  'referencesResult',
  'renameResult',
  'codeActionResult',
  'workspaceSymbolResult',
  'signatureResult',
  'completion',
  'completionItemDetail',
  'hover',
  'diagnostics',
  'formatResult',
  'mdPreview',
  'folding',
  'inlayHints',
  // running code
  'runStart',
  'runOut',
  'runResult',
  'stopped',
  'termOut',
  'termResult',
  'scriptOut',
  'scriptResult',
  // tests
  'testStart',
  'testOut',
  'testCase',
  'testResult',
  'testCancelled',
  // debugging
  'debugState',
  'debugVars',
  'debugEval',
  'debugOut',
  // workspace and files
  'fsListing',
  'fsFile',
  'fsSaved',
  'fsChanged',
  'workspaceEditsApplied',
  'fsRoot',
  'fsError',
  'drafts',
  'draftSaved',
  'draftDropped',
  'draftError',
  // local revision history
  'historyEntries',
  'historyFile',
  'historyReverted',
  // languages, plugins, dependencies
  'interpreters',
  'interpreterSet',
  'envStarted',
  'envOut',
  'envDone',
  'ideaImport',
  'attribution',
  'dependencies',
  'dependencyStart',
  'dependencyOut',
  'dependencyResult',
  'dependencyCancelled',
  'depResult',
  'extensions',
  'extension',
  'extensionResult',
  // MCP
  'mcp',
  'mcpCallResult',
  'mcpError',
  // project templates and run configurations
  'templates',
  'projectCandidates',
  'nativePicked',
  'templateGenerated',
  'runConfigs',
  // profiler / coverage / flame sampler
  'profileResult',
  'coverageResult',
  'flame',
  // git
  'gitStatus',
  'gitCommitResult',
  // AI assistant
  'aiConfig',
  'aiOut',
  'aiDone',
  'aiCancelled',
  // sandbox and misc
  'commandResult',
] as const;

export type ClientToEngineKind = (typeof CLIENT_TO_ENGINE)[number];
export type EngineToClientKind = (typeof ENGINE_TO_CLIENT)[number];
