// Public API for the Nolanguage kernel — stages 1–6.
//
//  Stage 1  minimal kernel: three buses + performance spine + log spine
//  Stage 2  dev panel: WebSocket transport + PanelHub + live UI
//  Stage 3  single-language loop: LSP client + log collector + Python runner
//  Stage 4  Python workspace (IDE): editor backend + samples + IDE UI
//  Stage 5  Go: toolchain discovery + GoRunner + gopls, unified behind the IDE
//  Stage 6  baseline system: git commit 打点 + SQLite persistence + long-term baselines
//
// Runtime note: the sources are TypeScript with NodeNext `.js` specifiers and
// are meant to be run directly via `node --experimental-transform-types` (see
// resolve-loader.mjs) or compiled with `tsc`.

// ---------------- Stage 1 · kernel ----------------
export { Kernel } from './kernel/Kernel.js';
export type { KernelOptions } from './kernel/Kernel.js';

export type {
  Kernel as IKernel,
  Disposable,
  CommandMeta, CommandHandler, CommandContext, CommandMiddleware, CommandBus,
  EventHandler, EventBus,
  ServiceLifecycle, ServiceOptions, ServiceContext, ServiceFactory, ServiceRegistry,
  LogResourceScope, LogCorrelation,
  // Aliased: the extension host exports its own `ViewContribution` /
  // `LanguageContribution` (manifest shapes) further down this file.
  ViewContribution as KernelViewContribution, ViewRegistry,
  LanguageContribution as KernelLanguageContribution, LanguageRegistry,
  ConfigScope, Configuration,
  LoggerFactory,
} from './kernel/types.js';

// ---------------- Stage 1 · performance spine ----------------
export type {
  PerfResource, PerfScope, PerfCorrelation, PerfEnvironment,
  PerfEnvelope, PerfEvent, PerfSample, PerfMetric, PerfRecord, PerfResourceScope,
} from './perf/types.js';
export { RingBuffer } from './util/ringBuffer.js';
export { LiveMetrics } from './perf/LiveMetrics.js';
export type { MetricSummary } from './perf/LiveMetrics.js';
export { PerfStore } from './perf/PerfStore.js';
export { PerfSpine } from './perf/PerfSpine.js';
export type { PerfSpineOptions } from './perf/PerfSpine.js';
export { TracerImpl } from './perf/Tracer.js';
export type { Tracer, Span } from './perf/Tracer.js';

// ---------------- Stage 1 · log spine ----------------
export type {
  LogEnvironment, LogResource, LogCodeScope, LogError, LogRecord,
} from './log/types.js';
export { LogLevel, LOG_LEVEL_NAMES, levelFromName } from './log/LogLevel.js';
export type { Logger } from './log/Logger.js';
export { LoggerImpl } from './log/Logger.js';
export type { LogTransport, LogPipelineOptions } from './log/LogPipeline.js';
export { LogPipeline } from './log/LogPipeline.js';
export { LogSampler } from './log/LogSampler.js';
export type { SamplerOptions } from './log/LogSampler.js';
export { LogFactory } from './log/LogFactory.js';
export { LogSpine } from './kernel/LogSpine.js';
export type { LogSpineOptions } from './kernel/LogSpine.js';
export { ConsoleTransport } from './log/transports/ConsoleTransport.js';

// ---------------- Extension host (Stage 2 · 面板接入) ----------------
export { ExtensionManager } from './extensions/ExtensionManager.js';
export type { ExtensionManagerOptions, ExtensionPanelInfo } from './extensions/ExtensionManager.js';
export { ExtensionRegistry, parseManifest, satisfies, ManifestError } from './extensions/ExtensionRegistry.js';
export { ExtensionHost } from './extensions/ExtensionHost.js';
export type {
  ExtensionManifest,
  CommandContribution,
  LanguageContribution,
  ViewContribution,
} from './extensions/Manifest.js';
export type { ExtensionModule, ExtensionContext } from './extensions/api.js';

// ---------------- Stage 1 · correlation + utils ----------------
export { CorrelationBus } from './correlation/CorrelationBus.js';
export { ulid } from './util/ulid.js';
export { detectEnvironment } from './util/env.js';

// ---------------- Stage 2 · dev panel ----------------
export { PanelHub, toClientLog } from './panel/PanelHub.js';
export type {
  PanelHubOptions, PanelSink, PanelFilter, PanelServerMessage,
  ClientLogRecord, SlowEntry, PanelLevelName,
} from './panel/PanelHub.js';
export { WebSocketServer, WebSocketConnection } from './net/websocket.js';
export type { WsServerOptions } from './net/websocket.js';
export { renderPanelHtml } from './ui/ui.js';
export { startDemo, startTraffic } from './panel/demo-commands.js';

// ---------------- Stage 3 · LSP ----------------
export { JsonRpcConnection, connectChildProcess } from './lsp/jsonrpc.js';
export type { JsonRpcMessage, RpcHooks, RpcClientOptions } from './lsp/jsonrpc.js';
export { LspLogCollector } from './lsp/LspLogCollector.js';
export type { LspLogCollectorOptions, LspLogStats } from './lsp/LspLogCollector.js';
export {
  LspClient, fileUri,
} from './lsp/LspClient.js';
export type {
  LspClientOptions, LspLaunchSpec, LspClientEvents, ServerCapabilities,
  Diagnostic, CompletionItem, Hover, Position, Range,
} from './lsp/LspClient.js';

// ---------------- Stage 3 · Python execution ----------------
export { PythonRunner } from './python/PythonRunner.js';
export type { RunOptions, RunResult } from './python/PythonRunner.js';

// ---------------- Stage 3 · combined loop (feeds the panel) ----------------
export { startPythonLoop } from './panel/pythonTraffic.js';
export type { PythonLoopOptions, PythonLoopHandle } from './panel/pythonTraffic.js';

// ---------------- Stage 4 · Python workspace (IDE) ----------------
export { WorkspaceService } from './panel/WorkspaceService.js';
export type {
  WorkspaceServiceOptions,
  DiagnoseResult,
  WorkspaceRunResult,
  LanguageStatus,
} from './panel/WorkspaceService.js';
export { SAMPLES, defaultSample, samplesFor, sampleById, starterFor } from './panel/samples.js';
export type { Sample, LanguageDescriptor, LanguageId, RunMode } from './panel/samples.js';

// ---------------- Stage 5 · Go ----------------
export { GoRunner } from './go/GoRunner.js';
export type { GoRunOptions, GoRunResult, GoMode } from './go/GoRunner.js';
export { resolveGoBin, discoverGoServer, goBinDir } from './go/discover.js';
export type { GoBinResolution, GoServerResolution } from './go/discover.js';

// ---------------- Stage 6 · baseline system ----------------
export { SqliteStore, JsonlArchiver, SCHEMA_VERSION } from './store/SqliteStore.js';
export type {
  SqliteStoreOptions, StoreStats, RotationResult, LogRow, Archiver,
} from './store/SqliteStore.js';
export { LogSink } from './store/LogSink.js';
export type { LogSinkOptions, SinkStats } from './store/LogSink.js';
export {
  runLogQuery, countLogs, aggregateLogs, buildLogQuery, buildLogWhere, hydrateLogRow, LOG_QUERIES,
} from './store/LogQuery.js';
export type {
  LogQuery, LogEntry, LogFieldFilter, FieldOp, LogAggregationBucket, BuiltQuery, BuiltWhere,
} from './store/LogQuery.js';
export {
  fuse, fuseByTrace, fuseByCommit, fuseBySession, fuseByFile,
  perfMetricsForTrace, metricLogs,
} from './store/Fusion.js';
export type { FusionResult, FusionEntry, FusionKey, PerfRow } from './store/Fusion.js';

export { BaselineStore, defaultHigherIsBetter, fmtPct } from './perf/BaselineStore.js';
export type {
  BaselineRecord, BaselineComparison, BaselineThresholds, MetricDelta, DeltaStatus, CaptureMeta,
  BaselineStoreOptions,
} from './perf/BaselineStore.js';
export { AutoBaseline } from './perf/AutoBaseline.js';
export type {
  AutoBaselineOptions, BaselineCheckpoint, BaselineEvent,
} from './perf/AutoBaseline.js';

export { probeGit, runGit, gitVersion, GitProbe } from './git/GitProbe.js';
export type { GitInfo, GitProbeOptions } from './git/GitProbe.js';
export { hashConfig } from './correlation/CorrelationBus.js';
export type { CorrelationBusOptions } from './correlation/CorrelationBus.js';
